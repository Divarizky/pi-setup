import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentInitialTerminal,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import {
  OrcaCli,
  OrcaTerminalAdapter,
  type OrcaCreatedTerminal,
} from "../transports/orca-cli.ts";
import { typeAndSubmit } from "../transports/composer.ts";
import { buildSubagentExecutionPrompt } from "../prompt.ts";
import { hasStructuredReport } from "../report.ts";
import { boundedError, redactSensitiveText } from "../security.ts";

const ORCA_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const ORCA_STABLE_IDLE_DEFAULT_MS = 3_000;
const ORCA_IDLE_PROBE_TIMEOUT_MS = 10_000;
const ORCA_READ_PAGE_LIMIT = 8_000;
const ORCA_MAX_READ_PAGES = 64;
const ORCA_STARTUP_TIMEOUT_DEFAULT_MS = 120_000;
const MAX_INBOX_MESSAGES = 64;
const MAX_INBOX_BYTES = 256 * 1024;
const MAX_INBOX_MESSAGE_BYTES = 32 * 1024;
const OVERLOAD_PATTERN = /temporarily overloaded|rate limit exceeded/i;
/** Short wake line typed into the terminal; the payload itself stays on disk. */
const DOORBELL_TEXT = "New queued message waiting.";

export interface OrcaBackendOptions {
  /** Silence window required before a turn is considered settled. */
  readonly stableIdleMs?: number;
  /** How long to keep probing while the terminal only echoes our own prompt (Pi still booting). */
  readonly startupTimeoutMs?: number;
  /** Root directory for durable per-job steering inboxes (`<inboxRoot>/<jobId>`). */
  readonly inboxRoot?: string;
}
const MAX_TERMINAL_OUTPUT = 1_024 * 1_024;

function boundedText(value: string) {
  return value.slice(-MAX_TERMINAL_OUTPUT);
}

function redactTerminalText(value: string) {
  return boundedText(redactSensitiveText(value));
}

function terminalText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.terminal && typeof record.terminal === "object") {
    return terminalText(record.terminal);
  }
  const lines = record.lines ?? record.tail;
  if (Array.isArray(lines)) {
    return lines
      .map((line) => {
        if (typeof line === "string") return line;
        if (!line || typeof line !== "object") return "";
        const item = line as Record<string, unknown>;
        return typeof item.text === "string"
          ? item.text
          : typeof item.content === "string"
            ? item.content
            : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  for (const key of ["text", "output", "content"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function failedOutcome(errorText: string): RunOutcome {
  return { _tag: "Failed", errorText };
}

export type OrcaSessionClient = Pick<
  OrcaCli,
  | "createPiTerminal"
  | "listTerminals"
  | "read"
  | "send"
  | "waitForIdle"
  | "stop"
> & {
  /** Runtime readiness gate; when absent, availability falls back to listTerminals. */
  readonly assertReady?: () => Promise<void>;
  readonly type?: (terminalHandle: string, text: string) => Promise<void>;
  readonly submit?: (terminalHandle: string) => Promise<void>;
  readonly interruptKey?: (terminalHandle: string) => Promise<void>;
};

interface OrcaSessionOptions {
  readonly initialTerminal?: SubagentInitialTerminal;
  readonly startPrompt?: boolean;
  /** The agent-first Orca create command already submitted the initial prompt. */
  readonly promptAlreadySent?: boolean;
  /** Reattach observes the existing terminal run without sending a duplicate prompt. */
  readonly observeExisting?: boolean;
  readonly stableIdleMs?: number;
  readonly startupTimeoutMs?: number;
  /** Durable steering inbox directory for this job; enables queue-while-busy. */
  readonly inboxDir?: string;
}

const makeOrcaSession = (
  task: SpawnTask,
  cli: OrcaSessionClient,
  options: OrcaSessionOptions = {},
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!task.worktree) {
      return yield* new SpawnError({
        message: "Orca backend requires an isolated worktree.",
      });
    }
    if (!task.jobId) {
      return yield* new SpawnError({
        message: "Orca backend requires a manager-assigned job id.",
      });
    }

    const adapter = new OrcaTerminalAdapter(cli);
    const terminal =
      options.initialTerminal ??
      (yield* Effect.tryPromise({
        try: () => cli.createPiTerminal({ worktreePath: task.worktree!.path }),
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      }));
    if (!terminal.worktreeId) {
      return yield* new SpawnError({
        message:
          "Orca CLI did not return a worktree id; refusing unscoped terminal control.",
      });
    }
    adapter.attach({
      jobId: task.jobId,
      terminalHandle: terminal.handle,
      worktreeId: terminal.worktreeId,
      worktreePath: task.worktree.path,
    });

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const state = { closed: false, running: false, settled: false };
    // True once the terminal has produced meaningful output; literal typing is
    // only gated after the agent TUI is proven alive (boot windows look unknown).
    let hasSeenOutput = false;
    let activeTerminal: OrcaCreatedTerminal | undefined = terminal;
    let generation = 0;
    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
    let meta: SubagentMeta = {
      backend: "orca",
      modelLabel: "pi/orca-terminal",
      ...(terminal.sessionId === undefined
        ? {}
        : { nativeSessionId: terminal.sessionId }),
      nativeTerminalHandle: terminal.handle,
      nativeWorktreeId: terminal.worktreeId,
      ...(terminal.tabId === undefined ? {} : { nativeTabId: terminal.tabId }),
      ...(terminal.paneKey === undefined
        ? {}
        : { nativePaneKey: terminal.paneKey }),
      ...(terminal.launchToken === undefined
        ? {}
        : { nativeLaunchToken: terminal.launchToken }),
    };
    const attachTerminal = (next: typeof terminal) => {
      if (!next.worktreeId)
        throw new Error(
          "Orca CLI did not return a worktree id; refusing unscoped terminal control.",
        );
      activeTerminal = next;
      adapter.attach({
        jobId: task.jobId!,
        terminalHandle: next.handle,
        worktreeId: next.worktreeId!,
        worktreePath: task.worktree!.path,
      });
      meta = {
        ...meta,
        ...(next.sessionId === undefined
          ? {}
          : { nativeSessionId: next.sessionId }),
        nativeTerminalHandle: next.handle,
        nativeWorktreeId: next.worktreeId!,
        ...(next.tabId === undefined ? {} : { nativeTabId: next.tabId }),
        ...(next.paneKey === undefined ? {} : { nativePaneKey: next.paneKey }),
        ...(next.launchToken === undefined
          ? {}
          : { nativeLaunchToken: next.launchToken }),
      };
      emit({ _tag: "MetaChanged", meta });
    };
    const ensureTerminal = async () => {
      if (activeTerminal) return activeTerminal;
      const next = await cli.createPiTerminal({
        worktreePath: task.worktree!.path,
      });
      attachTerminal(next);
      // A replacement terminal has a new cursor space; never send the old
      // terminal's cursor to it.
      outputCursor = undefined;
      return next;
    };

    // --- Durable steering inbox ------------------------------------------------

    interface InboxEntry {
      readonly file?: string;
      readonly text: string;
    }
    const inboxQueue: InboxEntry[] = [];
    const inboxDir = options.inboxDir;

    const emitQueued = () =>
      emit({
        _tag: "QueueChanged",
        queued: inboxQueue.map((entry) => ({
          text: entry.text,
          kind: "follow-up" as const,
        })),
      });

    let persistChain = Promise.resolve();
    let enqueueChain = Promise.resolve();
    const inboxQueueBytes = () =>
      inboxQueue.reduce(
        (total, item) => total + Buffer.byteLength(item.text, "utf8"),
        0,
      );
    const reportInboxFailure = (message: string) =>
      emit({
        _tag: "BackendError",
        message: `Orca steering inbox: ${message}`,
      });

    /** Restore messages persisted by a previous session before a crash/restart. */
    const loadInbox = async () => {
      if (!inboxDir) return;
      try {
        const names = (await fs.readdir(inboxDir))
          .filter((name) => name.endsWith(".msg"))
          .sort();
        let bytes = 0;
        for (const name of names) {
          if (inboxQueue.length >= MAX_INBOX_MESSAGES) {
            reportInboxFailure(
              `message limit (${MAX_INBOX_MESSAGES}) exceeded; remaining files were preserved.`,
            );
            break;
          }
          const text = (
            await fs.readFile(path.join(inboxDir, name), "utf8")
          ).trim();
          const size = Buffer.byteLength(text, "utf8");
          if (!text) continue;
          if (
            size > MAX_INBOX_MESSAGE_BYTES ||
            bytes + size > MAX_INBOX_BYTES
          ) {
            reportInboxFailure(
              `size limit exceeded while restoring ${name}; the file was preserved.`,
            );
            continue;
          }
          inboxQueue.push({ file: name, text });
          bytes += size;
        }
        if (inboxQueue.length > 0) emitQueued();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") reportInboxFailure(boundedError(error));
      }
    };

    const persistIncoming = async (text: string): Promise<string> => {
      if (!inboxDir)
        throw new Error("Durable Orca steering inbox is unavailable.");
      const operation = persistChain.then(async () => {
        const size = Buffer.byteLength(text, "utf8");
        if (size > MAX_INBOX_MESSAGE_BYTES) {
          throw new Error(
            `message exceeds ${MAX_INBOX_MESSAGE_BYTES}-byte limit`,
          );
        }
        await fs.mkdir(inboxDir, { recursive: true });
        const names = (await fs.readdir(inboxDir)).filter((name) =>
          name.endsWith(".msg"),
        );
        const memoryOnly = inboxQueue.filter((item) => item.file === undefined);
        if (names.length + memoryOnly.length >= MAX_INBOX_MESSAGES) {
          throw new Error(`message limit (${MAX_INBOX_MESSAGES}) reached`);
        }
        let existingBytes = 0;
        for (const name of names)
          existingBytes += (await fs.stat(path.join(inboxDir, name))).size;
        const memoryOnlyBytes = memoryOnly.reduce(
          (total, item) => total + Buffer.byteLength(item.text, "utf8"),
          0,
        );
        if (existingBytes + memoryOnlyBytes + size > MAX_INBOX_BYTES) {
          throw new Error(`size limit (${MAX_INBOX_BYTES} bytes) reached`);
        }
        const file = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.msg`;
        const target = path.join(inboxDir, file);
        const temporary = `${target}.tmp`;
        await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
        try {
          await fs.rename(temporary, target);
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        return file;
      });
      persistChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    };

    /** Queue a steering message while the worker is busy; payload stays on disk. */
    const enqueueWhileRunning = (text: string) => {
      const operation = enqueueChain.then(async () => {
        const size = Buffer.byteLength(text, "utf8");
        if (size > MAX_INBOX_MESSAGE_BYTES) {
          throw new Error(
            `message exceeds ${MAX_INBOX_MESSAGE_BYTES}-byte limit`,
          );
        }
        if (
          inboxQueue.length >= MAX_INBOX_MESSAGES ||
          inboxQueueBytes() + size > MAX_INBOX_BYTES
        ) {
          throw new Error("durable steering queue limit reached");
        }
        const file = await persistIncoming(text);
        inboxQueue.push({ file, text });
        emitQueued();
        try {
          // Best-effort doorbell only; the payload itself is never typed while busy.
          await pushTurnInput(DOORBELL_TEXT);
        } catch {
          // The durable message survives even when the wake line cannot be typed.
        }
      });
      enqueueChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    };

    const restoreBatch = (batch: ReadonlyArray<InboxEntry>) => {
      inboxQueue.unshift(...batch);
      emitQueued();
    };

    /** Start one follow-up turn with every queued message, then archive them after success. */
    const drainIfPending = () => {
      if (state.closed || inboxQueue.length === 0) return;
      const expectedGeneration = generation;
      const batch = inboxQueue.splice(0);
      emitQueued();
      void (async () => {
        if (state.closed || generation !== expectedGeneration) {
          restoreBatch(batch);
          return;
        }
        void runTurn(batch.map((item) => item.text).join("\n\n"), batch);
      })();
    };

    let initialPromptPending = options.promptAlreadySent === true;
    // Orca terminal reads are cursor-based. Keep the last cursor so follow-up
    // turns cannot mistake an earlier turn's report for the current one.
    let outputCursor: number | undefined;
    const stableIdleMs = Math.max(
      0,
      options.stableIdleMs ?? ORCA_STABLE_IDLE_DEFAULT_MS,
    );
    const startupTimeoutMs = Math.max(
      0,
      options.startupTimeoutMs ?? ORCA_STARTUP_TIMEOUT_DEFAULT_MS,
    );
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const normalizeWhitespace = (value: string) =>
      value.replace(/\s+/g, " ").trim();

    const hasValidStructuredReport = (value: string) =>
      hasStructuredReport(value);

    /**
     * Readiness gate: scrollback that only echoes our own prompt means Pi is still
     * booting. Idle alone proves nothing; a report marker inside that echo is not
     * a report. Orca/shell quoting may render line breaks differently, so detect
     * the stable launch-prompt shape before using character-count fallback.
     */
    const hasMeaningfulOutput = (
      raw: string,
      echoes: ReadonlyArray<string>,
    ) => {
      const normalizedRaw = normalizeWhitespace(raw);
      const launchEcho =
        normalizedRaw.includes("You are a build subagent") &&
        normalizedRaw.includes("The parent agent supplied the task below") &&
        normalizedRaw.includes("Task briefing:");
      if (launchEcho && !hasValidStructuredReport(raw)) return false;

      // Strip our own echoed prompts first. Keep escaped/newline variants because
      // terminal scrollback may show the argv shell representation instead.
      let rest = normalizedRaw;
      for (const echo of echoes) {
        const variants = new Set([
          normalizeWhitespace(echo),
          normalizeWhitespace(echo.replace(/\\\\n/g, "\n")),
          normalizeWhitespace(echo.replace(/\n/g, "\\n")),
        ]);
        for (const needle of variants) {
          if (!needle) continue;
          const at = rest.indexOf(needle);
          if (at >= 0)
            rest = (
              rest.slice(0, at) +
              " " +
              rest.slice(at + needle.length)
            ).trim();
        }
      }
      // Any non-empty text left after removing our own launch/input echo proves
      // that the process responded. Short answers such as "done" must not
      // wait for the full startup timeout.
      return (
        hasValidStructuredReport(rest) ||
        OVERLOAD_PATTERN.test(rest) ||
        rest.length > 0
      );
    };

    /** Idle is only trusted after a silence window confirms it is stable. */
    const waitForStableIdle = async () => {
      const overallTimeout = Math.min(
        task.timeoutMs ?? ORCA_WAIT_TIMEOUT_MS,
        ORCA_WAIT_TIMEOUT_MS,
      );
      const deadline = Date.now() + overallTimeout;
      while (Date.now() < deadline) {
        await adapter.waitForIdle(
          task.jobId!,
          Math.max(1, deadline - Date.now()),
        );
        await delay(stableIdleMs);
        if (Date.now() >= deadline) return;
        try {
          await adapter.waitForIdle(
            task.jobId!,
            Math.min(
              ORCA_IDLE_PROBE_TIMEOUT_MS,
              Math.max(1, deadline - Date.now()),
            ),
          );
        } catch {
          continue; // Output resumed during the silence window; keep waiting.
        }
        return;
      }
    };

    /**
     * Read output for the current turn. The first read may inspect the existing
     * tail because an agent-first launch has already submitted its prompt. Every
     * later read starts at the last cursor returned by Orca, so follow-ups only
     * see newly appended terminal lines.
     */
    const readTurnOutput = async (): Promise<string> => {
      let cursor = outputCursor;
      let complete = false;
      const parts: string[] = [];
      for (let page = 0; page < ORCA_MAX_READ_PAGES; page++) {
        const chunk = await adapter.read(
          task.jobId!,
          cursor === undefined
            ? { limit: ORCA_READ_PAGE_LIMIT }
            : { cursor, limit: ORCA_READ_PAGE_LIMIT },
        );
        parts.push(terminalText(chunk));
        const record = chunk as Record<string, unknown>;
        const next =
          typeof record.nextCursor === "number" ? record.nextCursor : undefined;
        const latest =
          typeof record.latestCursor === "number"
            ? record.latestCursor
            : undefined;
        if (next === undefined || next === cursor) {
          outputCursor = latest ?? next ?? cursor;
          complete = true;
          break;
        }
        cursor = next;
        outputCursor = next;
      }
      if (!complete) {
        throw new Error(
          `Orca terminal output exceeded the ${ORCA_MAX_READ_PAGES}-page safety limit before the report was captured.`,
        );
      }
      return redactTerminalText(boundedText(parts.join("\n")));
    };

    const collectTurnOutput = async (): Promise<string> => {
      await waitForStableIdle();
      const output = await readTurnOutput();
      if (output.length > 0) hasSeenOutput = true;
      return output;
    };

    /** Literal typing with a composer gate once the agent TUI is proven alive. */
    const pushTurnInput = async (text: string): Promise<void> => {
      if (!adapter.supportsLiteralTyping || !hasSeenOutput) {
        // ponytail: boot-window sends stay ungated until Orca exposes a
        // process-ready signal; the composer gate activates after first output.
        await adapter.send(task.jobId!, text);
        return;
      }
      const result = await typeAndSubmit(
        {
          readTail: (limit) => adapter.read(task.jobId!, { limit }),
          type: (value) => adapter.type(task.jobId!, value),
          submit: () => adapter.submit(task.jobId!),
        },
        text,
      );
      if (result !== "submitted") {
        throw new Error(
          "Orca composer state is unidentifiable; refusing to blind-submit. Inspect the terminal, then retry.",
        );
      }
    };

    const NUDGE_TEXT =
      "Your final message did not contain the required <subagent-report> JSON block. Emit it now as your entire final message.";

    const archiveInboxBatch = async (batch: ReadonlyArray<InboxEntry>) => {
      const remaining: InboxEntry[] = [];
      if (inboxDir) {
        for (const item of batch) {
          if (!item.file) continue;
          const source = path.join(inboxDir, item.file);
          const target = path.join(
            inboxDir,
            item.file.replace(/\.msg$/, ".sent"),
          );
          try {
            await fs.rename(source, target);
          } catch (error) {
            try {
              await fs.access(target);
            } catch {
              remaining.push(item);
              reportInboxFailure(
                `could not archive ${item.file}: ${boundedError(error)}`,
              );
            }
          }
        }
      }
      if (remaining.length > 0) restoreBatch(remaining);
      return remaining.length === 0;
    };

    const runTurn = async (
      text: string,
      archiveBatch: ReadonlyArray<InboxEntry> = [],
    ) => {
      if (state.closed) return;
      const turn = ++generation;
      state.running = true;
      state.settled = false;
      emit({ _tag: "RunStarted" });
      emit({ _tag: "UserMessage", text });
      try {
        await ensureTerminal();
        if (turn !== generation || state.closed) return;
        if (!initialPromptPending) await pushTurnInput(text);
        initialPromptPending = false;
        // ponytail: startup gate is time-boxed, not event-driven — swap for an Orca
        // process-started signal when the CLI exposes one.
        const startupDeadline =
          Date.now() + Math.min(startupTimeoutMs, ORCA_WAIT_TIMEOUT_MS);
        let output = "";
        let ready = false;
        while (!ready && (output === "" || Date.now() < startupDeadline)) {
          output = await collectTurnOutput();
          if (turn !== generation || state.closed) return;
          ready = hasMeaningfulOutput(output, [text]);
        }
        if (!ready) {
          emit({
            _tag: "RunSettled",
            outcome: failedOutcome(
              `Pi produced no readable output within ${Math.round(startupTimeoutMs / 1000)}s of launch (terminal likely still starting or Pi exited early). This failure is retryable with subagent_retry in the same worktree.`,
            ),
          });
          return;
        }
        if (!hasValidStructuredReport(output)) {
          // Recovery is per turn. The cursor ensures this response cannot be
          // satisfied by a report from an earlier turn.
          try {
            await pushTurnInput(NUDGE_TEXT);
            await waitForStableIdle();
            const nudgedOutput = await readTurnOutput();
            output = [output, nudgedOutput].filter(Boolean).join("\n");
          } catch {
            // A failed nudge must not mask the turn outcome.
          }
          if (turn !== generation || state.closed) return;
        }
        if (turn !== generation || state.closed) return;
        if (
          !hasValidStructuredReport(output) &&
          OVERLOAD_PATTERN.test(output)
        ) {
          emit({
            _tag: "RunSettled",
            outcome: failedOutcome(
              "Pi hit API capacity limits (temporarily overloaded) before producing its report. This failure is retryable with subagent_retry in the same worktree.",
            ),
          });
          return;
        }
        if (output) {
          emit({
            _tag: "AssistantMessage",
            parts: [{ type: "text", text: output }],
          });
        }
        const archived =
          archiveBatch.length === 0 || (await archiveInboxBatch(archiveBatch));
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Completed",
            finalText:
              output || "Orca Pi terminal became idle without readable output.",
          },
        });
        if (archived) drainIfPending();
      } catch (error) {
        if (turn !== generation || state.closed) return;
        const message = boundedError(error);
        activeTerminal = undefined;
        emit({ _tag: "BackendError", message });
        emit({ _tag: "RunSettled", outcome: failedOutcome(message) });
      } finally {
        if (turn === generation) {
          state.running = false;
          state.settled = true;
        }
      }
    };

    const observeExistingTurn = async () => {
      if (state.closed) return;
      const turn = ++generation;
      state.running = true;
      state.settled = false;
      emit({ _tag: "RunStarted" });
      try {
        const expectedEcho = buildSubagentExecutionPrompt({
          mode: task.mode ?? "build",
          title: task.title,
          prompt: task.prompt,
        });
        const startupDeadline =
          Date.now() + Math.min(startupTimeoutMs, ORCA_WAIT_TIMEOUT_MS);
        let output = "";
        let ready = false;
        while (!ready && (output === "" || Date.now() < startupDeadline)) {
          output = await collectTurnOutput();
          if (turn !== generation || state.closed) return;
          ready = hasMeaningfulOutput(output, [expectedEcho]);
        }
        if (turn !== generation || state.closed) return;
        if (!ready) {
          emit({
            _tag: "RunSettled",
            outcome: failedOutcome(
              `Reattached terminal produced no readable output beyond the launch prompt within ${Math.round(startupTimeoutMs / 1000)}s. This failure is retryable with subagent_retry in the same worktree.`,
            ),
          });
          return;
        }
        if (output)
          emit({
            _tag: "AssistantMessage",
            parts: [{ type: "text", text: output }],
          });
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Completed",
            finalText:
              output ||
              "Reattached Orca Pi terminal became idle without readable output.",
          },
        });
        drainIfPending();
      } catch (error) {
        if (turn !== generation || state.closed) return;
        const message = boundedError(error);
        emit({ _tag: "BackendError", message });
        emit({ _tag: "RunSettled", outcome: failedOutcome(message) });
      } finally {
        if (turn === generation) {
          state.running = false;
          state.settled = true;
        }
      }
    };

    yield* Effect.promise(() => loadInbox());
    emit({ _tag: "MetaChanged", meta });
    if (options.observeExisting) {
      void observeExistingTurn();
    } else if (options.startPrompt !== false) {
      void runTurn(
        buildSubagentExecutionPrompt({
          mode: task.mode ?? "build",
          title: task.title,
          prompt: task.prompt,
        }),
      );
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        if (!state.settled && activeTerminal) {
          try {
            await adapter.stop(task.jobId!);
          } catch {
            // best effort; the terminal status remains externally observable
          }
        }
        Queue.endUnsafe(events);
      }),
    );

    return {
      meta: Effect.succeed(meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend(() => {
          if (state.closed)
            return new SendError({
              message: "Orca Pi terminal session is closed.",
            });
          if (state.running) {
            // Durable steering: persist the message and ring a best-effort
            // doorbell instead of rejecting the caller while the worker is busy.
            return Effect.tryPromise({
              try: () => enqueueWhileRunning(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          void runTurn(text);
          return Effect.void;
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        const wasActive = state.running || !state.settled;
        generation++;
        if (activeTerminal) {
          try {
            if (adapter.supportsInterruptKey) {
              await adapter.interruptKey(task.jobId!);
            } else {
              await adapter.stop(task.jobId!);
              activeTerminal = undefined;
            }
          } catch (error) {
            emit({ _tag: "BackendError", message: boundedError(error) });
            activeTerminal = undefined;
          }
        }
        if (wasActive)
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        state.settled = true;
        state.running = false;
      }),
      probeStatus: Effect.promise(() => adapter.probe(task.jobId!)),
    };
  });

export function makeOrcaBackend(
  cli: OrcaSessionClient = new OrcaCli(),
  options: OrcaBackendOptions = {},
): SubagentBackend {
  const stableIdleMs = options.stableIdleMs ?? ORCA_STABLE_IDLE_DEFAULT_MS;
  const startupTimeoutMs =
    options.startupTimeoutMs ?? ORCA_STARTUP_TIMEOUT_DEFAULT_MS;
  const inboxDirFor = (task: SpawnTask) =>
    options.inboxRoot && task.jobId
      ? path.join(options.inboxRoot, task.jobId)
      : undefined;
  return {
    name: "orca",
    capabilities: {
      steering: true,
      modelSelection: false,
      reasoningEffort: false,
    },
    available: Effect.promise(async () => {
      try {
        if (cli.assertReady) await cli.assertReady();
        else await cli.listTerminals();
        return true;
      } catch {
        return false;
      }
    }),
    spawn: (task) =>
      makeOrcaSession(task, cli, {
        ...(task.initialTerminal
          ? { initialTerminal: task.initialTerminal, promptAlreadySent: true }
          : {}),
        stableIdleMs,
        startupTimeoutMs,
        ...(inboxDirFor(task) === undefined
          ? {}
          : { inboxDir: inboxDirFor(task) }),
      }),
    reattach: (task, identity) =>
      Effect.gen(function* () {
        if (!identity.nativeTerminalHandle || !identity.nativeWorktreeId) {
          return yield* new SpawnError({
            message: "Orca reattach requires terminal and worktree identity.",
          });
        }
        const terminal = yield* Effect.tryPromise({
          try: async () => {
            const terminals = await cli.listTerminals(
              identity.nativeWorktreeId!,
            );
            const found = terminals.find(
              (item) => item.handle === identity.nativeTerminalHandle,
            );
            if (
              !found ||
              !found.connected ||
              found.orphaned ||
              found.worktreeId !== identity.nativeWorktreeId
            ) {
              throw new Error(
                "Orca terminal is missing, disconnected, orphaned, or bound to another worktree.",
              );
            }
            const identityFields = [
              ["tab", identity.nativeTabId, found.tabId],
              ["pane", identity.nativePaneKey, found.paneKey],
              ["session", identity.nativeSessionId, found.sessionId],
              ["launch", identity.nativeLaunchToken, found.launchToken],
            ] as const;
            for (const [label, expected, actual] of identityFields) {
              if (expected !== undefined && actual !== expected) {
                throw new Error(
                  `Orca ${label} identity changed; refusing reattach.`,
                );
              }
            }
            return {
              handle: found.handle,
              worktreeId: found.worktreeId,
              ...(found.tabId === undefined ? {} : { tabId: found.tabId }),
              ...(identity.nativePaneKey === undefined
                ? {}
                : { paneKey: identity.nativePaneKey }),
              ...(identity.nativeSessionId === undefined
                ? {}
                : { sessionId: identity.nativeSessionId }),
              ...(identity.nativeLaunchToken === undefined
                ? {}
                : { launchToken: identity.nativeLaunchToken }),
            } satisfies OrcaCreatedTerminal;
          },
          catch: (error) => new SpawnError({ message: boundedError(error) }),
        });
        return yield* makeOrcaSession(task, cli, {
          initialTerminal: terminal,
          startPrompt: false,
          observeExisting: true,
          stableIdleMs,
          startupTimeoutMs,
          ...(inboxDirFor(task) === undefined
            ? {}
            : { inboxDir: inboxDirFor(task) }),
        });
      }),
  };
}

export const orcaBackend: SubagentBackend = makeOrcaBackend();
