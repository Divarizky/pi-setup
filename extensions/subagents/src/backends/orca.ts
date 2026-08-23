import type { Cause, Scope } from "effect"
import { Effect, Queue, Stream } from "effect"
import type { SubagentBackend, SubagentSession } from "../backend.ts"
import type {
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentInitialTerminal,
} from "../domain.ts"
import { SendError, SpawnError } from "../domain.ts"
import { OrcaCli, OrcaTerminalAdapter, type OrcaCreatedTerminal } from "../transports/orca-cli.ts"
import { assertWorktreeClean } from "../worktree.ts"
import { buildSubagentExecutionPrompt } from "../prompt.ts"

const ORCA_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const ORCA_STABLE_IDLE_DEFAULT_MS = 3_000
const ORCA_IDLE_PROBE_TIMEOUT_MS = 10_000
const ORCA_READ_PAGE_LIMIT = 8_000
const ORCA_MAX_READ_PAGES = 64
const ORCA_STARTUP_TIMEOUT_DEFAULT_MS = 120_000
// Minimum non-echo characters that prove the Pi process is actually alive.
const ORCA_MIN_MEANINGFUL_OUTPUT_CHARS = 20
const REPORT_PATTERN = /<subagent-report>\s*([\s\S]*?)\s*<\/subagent-report>/i
const OVERLOAD_PATTERN = /temporarily overloaded|rate limit exceeded/i

export interface OrcaBackendOptions {
  /** Silence window required before a turn is considered settled. */
  readonly stableIdleMs?: number
  /** How long to keep probing while the terminal only echoes our own prompt (Pi still booting). */
  readonly startupTimeoutMs?: number
}
const MAX_TERMINAL_OUTPUT = 1_024 * 1_024

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096)
}

function boundedText(value: string) {
  return value.slice(-MAX_TERMINAL_OUTPUT)
}

function redactTerminalText(value: string) {
  return boundedText(value)
    .replace(/(token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
}

function terminalText(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (record.terminal && typeof record.terminal === "object") {
    return terminalText(record.terminal)
  }
  const lines = record.lines ?? record.tail
  if (Array.isArray(lines)) {
    return lines.map((line) => {
      if (typeof line === "string") return line
      if (!line || typeof line !== "object") return ""
      const item = line as Record<string, unknown>
      return typeof item.text === "string"
        ? item.text
        : typeof item.content === "string" ? item.content : ""
    }).filter(Boolean).join("\n")
  }
  for (const key of ["text", "output", "content"]) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return ""
}

function failedOutcome(errorText: string): RunOutcome {
  return { _tag: "Failed", errorText }
}

export type OrcaSessionClient = Pick<OrcaCli, "createPiTerminal" | "listTerminals" | "read" | "send" | "waitForIdle" | "stop"> & {
  readonly assertWorktreeClean?: (worktreePath: string) => Promise<void>
}

interface OrcaSessionOptions {
  readonly initialTerminal?: SubagentInitialTerminal
  readonly startPrompt?: boolean
  /** The agent-first Orca create command already submitted the initial prompt. */
  readonly promptAlreadySent?: boolean
  /** Reattach observes the existing terminal run without sending a duplicate prompt. */
  readonly observeExisting?: boolean
  readonly stableIdleMs?: number
  readonly startupTimeoutMs?: number
}

const makeOrcaSession = (
  task: SpawnTask,
  cli: OrcaSessionClient,
  options: OrcaSessionOptions = {},
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!task.worktree) {
      return yield* new SpawnError({ message: "Orca backend requires an isolated worktree." })
    }
    if (!task.jobId) {
      return yield* new SpawnError({ message: "Orca backend requires a manager-assigned job id." })
    }

    const checkWorktree = cli.assertWorktreeClean ?? assertWorktreeClean
    if (task.mode === "scout") {
      yield* Effect.tryPromise({
        try: () => checkWorktree(task.worktree!.path),
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      })
    }
    const adapter = new OrcaTerminalAdapter(cli)
    const terminal = options.initialTerminal ?? (yield* Effect.tryPromise({
      try: () => cli.createPiTerminal({ worktreePath: task.worktree!.path, mode: task.mode ?? "build" }),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    }))
    if (!terminal.worktreeId) {
      return yield* new SpawnError({
        message: "Orca CLI did not return a worktree id; refusing unscoped terminal control.",
      })
    }
    adapter.attach({
      jobId: task.jobId,
      terminalHandle: terminal.handle,
      worktreeId: terminal.worktreeId,
      worktreePath: task.worktree.path,
    })

    const events = yield* Queue.make<SubagentEvent, Cause.Done>()
    const state = { closed: false, running: false, settled: false }
    let activeTerminal: OrcaCreatedTerminal | undefined = terminal
    let generation = 0
    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event)
    let meta: SubagentMeta = {
      backend: "orca",
      modelLabel: "pi/orca-terminal",
      ...(terminal.sessionId === undefined ? {} : { nativeSessionId: terminal.sessionId }),
      nativeTerminalHandle: terminal.handle,
      nativeWorktreeId: terminal.worktreeId,
      ...(terminal.tabId === undefined ? {} : { nativeTabId: terminal.tabId }),
      ...(terminal.paneKey === undefined ? {} : { nativePaneKey: terminal.paneKey }),
      ...(terminal.launchToken === undefined ? {} : { nativeLaunchToken: terminal.launchToken }),
    }
    const attachTerminal = (next: typeof terminal) => {
      if (!next.worktreeId) throw new Error("Orca CLI did not return a worktree id; refusing unscoped terminal control.")
      activeTerminal = next
      adapter.attach({
        jobId: task.jobId!,
        terminalHandle: next.handle,
        worktreeId: next.worktreeId!,
        worktreePath: task.worktree!.path,
      })
      meta = {
        ...meta,
        ...(next.sessionId === undefined ? {} : { nativeSessionId: next.sessionId }),
        nativeTerminalHandle: next.handle,
        nativeWorktreeId: next.worktreeId!,
        ...(next.tabId === undefined ? {} : { nativeTabId: next.tabId }),
        ...(next.paneKey === undefined ? {} : { nativePaneKey: next.paneKey }),
        ...(next.launchToken === undefined ? {} : { nativeLaunchToken: next.launchToken }),
      }
      emit({ _tag: "MetaChanged", meta })
    }
    const ensureTerminal = async () => {
      if (activeTerminal) return activeTerminal
      const next = await cli.createPiTerminal({ worktreePath: task.worktree!.path, mode: task.mode ?? "build" })
      attachTerminal(next)
      return next
    }

    let initialPromptPending = options.promptAlreadySent === true
    let nudgedReport = false
    const stableIdleMs = Math.max(0, options.stableIdleMs ?? ORCA_STABLE_IDLE_DEFAULT_MS)
    const startupTimeoutMs = Math.max(0, options.startupTimeoutMs ?? ORCA_STARTUP_TIMEOUT_DEFAULT_MS)
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

    const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim()

    const hasValidStructuredReport = (value: string) => {
      const match = value.match(REPORT_PATTERN)
      if (!match) return false
      try {
        const report = JSON.parse(match[1]) as Record<string, unknown>
        return typeof report.outcome === "string"
          && typeof report.summary === "string"
          && Array.isArray(report.changes)
          && Array.isArray(report.tests)
      } catch {
        return false
      }
    }

    /**
     * Readiness gate: scrollback that only echoes our own prompt means Pi is still
     * booting. Idle alone proves nothing; a report marker inside that echo is not
     * a report. Orca/shell quoting may render line breaks differently, so detect
     * the stable launch-prompt shape before using character-count fallback.
     */
    const hasMeaningfulOutput = (raw: string, echoes: ReadonlyArray<string>) => {
      const normalizedRaw = normalizeWhitespace(raw)
      const launchEcho = normalizedRaw.includes("You are a build subagent")
        && normalizedRaw.includes("The parent agent supplied the task below")
        && normalizedRaw.includes("Task briefing:")
      if (launchEcho && !hasValidStructuredReport(raw)) return false

      // Strip our own echoed prompts first. Keep escaped/newline variants because
      // terminal scrollback may show the argv shell representation instead.
      let rest = normalizedRaw
      for (const echo of echoes) {
        const variants = new Set([
          normalizeWhitespace(echo),
          normalizeWhitespace(echo.replace(/\\\\n/g, "\n")),
          normalizeWhitespace(echo.replace(/\n/g, "\\n")),
        ])
        for (const needle of variants) {
          if (!needle) continue
          const at = rest.indexOf(needle)
          if (at >= 0) rest = (rest.slice(0, at) + " " + rest.slice(at + needle.length)).trim()
        }
      }
      return hasValidStructuredReport(rest) || OVERLOAD_PATTERN.test(rest) || rest.length >= ORCA_MIN_MEANINGFUL_OUTPUT_CHARS
    }

    /** Idle is only trusted after a silence window confirms it is stable. */
    const waitForStableIdle = async () => {
      const overallTimeout = Math.min(task.timeoutMs ?? ORCA_WAIT_TIMEOUT_MS, ORCA_WAIT_TIMEOUT_MS)
      const deadline = Date.now() + overallTimeout
      while (Date.now() < deadline) {
        await adapter.waitForIdle(task.jobId!, Math.max(1, deadline - Date.now()))
        await delay(stableIdleMs)
        if (Date.now() >= deadline) return
        try {
          await adapter.waitForIdle(task.jobId!, Math.min(ORCA_IDLE_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())))
        } catch {
          continue // Output resumed during the silence window; keep waiting.
        }
        return
      }
    }

    /** Page through the entire terminal scrollback instead of trusting a tail window. */
    const readFullOutput = async (): Promise<string> => {
      let cursor: number | undefined
      const parts: string[] = []
      for (let page = 0; page < ORCA_MAX_READ_PAGES; page++) {
        const chunk = await adapter.read(task.jobId!, cursor === undefined ? { limit: ORCA_READ_PAGE_LIMIT } : { cursor, limit: ORCA_READ_PAGE_LIMIT })
        parts.push(terminalText(chunk))
        const record = chunk as Record<string, unknown>
        const next = typeof record.nextCursor === "number" ? record.nextCursor : undefined
        if (next === undefined || next === cursor) break
        cursor = next
      }
      return redactTerminalText(boundedText(parts.join("\n")))
    }

    const collectTurnOutput = async (): Promise<string> => {
      await waitForStableIdle()
      return readFullOutput()
    }

    const NUDGE_TEXT = "Your final message did not contain the required <subagent-report> JSON block. Emit it now as your entire final message."

    const runTurn = async (text: string) => {
      if (state.closed) return
      const turn = ++generation
      state.running = true
      state.settled = false
      emit({ _tag: "RunStarted" })
      emit({ _tag: "UserMessage", text })
      try {
        const current = await ensureTerminal()
        if (turn !== generation || state.closed) return
        if (!initialPromptPending) await adapter.send(task.jobId!, text)
        initialPromptPending = false
        if (task.mode === "scout") await checkWorktree(task.worktree!.path)
        // ponytail: startup gate is time-boxed, not event-driven — swap for an Orca
        // process-started signal when the CLI exposes one.
        const startupDeadline = Date.now() + Math.min(startupTimeoutMs, ORCA_WAIT_TIMEOUT_MS)
        let output = ""
        let ready = false
        while (!ready && (output === "" || Date.now() < startupDeadline)) {
          output = await collectTurnOutput()
          if (turn !== generation || state.closed) return
          ready = hasMeaningfulOutput(output, [text])
        }
        if (!ready) {
          emit({
            _tag: "RunSettled",
            outcome: failedOutcome(`Pi produced no readable output within ${Math.round(startupTimeoutMs / 1000)}s of launch (terminal likely still starting or Pi exited early). This failure is retryable with subagent_retry in the same worktree.`),
          })
          return
        }
        if (!hasValidStructuredReport(output) && !nudgedReport) {
          // One recovery nudge now that Pi is proven alive but finished without a report.
          nudgedReport = true
          await adapter.send(task.jobId!, NUDGE_TEXT)
          await waitForStableIdle()
          output = await readFullOutput()
          if (turn !== generation || state.closed) return
        }
        if (turn !== generation || state.closed) return
        if (!hasValidStructuredReport(output) && OVERLOAD_PATTERN.test(output)) {
          emit({
            _tag: "RunSettled",
            outcome: failedOutcome("Pi hit API capacity limits (temporarily overloaded) before producing its report. This failure is retryable with subagent_retry in the same worktree."),
          })
          return
        }
        if (output) {
          emit({ _tag: "AssistantMessage", parts: [{ type: "text", text: output }] })
        }
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Completed", finalText: output || "Orca Pi terminal became idle without readable output." },
        })
      } catch (error) {
        if (turn !== generation || state.closed) return
        const message = boundedError(error)
        activeTerminal = undefined
        emit({ _tag: "BackendError", message })
        emit({ _tag: "RunSettled", outcome: failedOutcome(message) })
      } finally {
        if (turn === generation) {
          state.running = false
          state.settled = true
        }
      }
    }

    const observeExistingTurn = async () => {
      if (state.closed) return
      const turn = ++generation
      state.running = true
      state.settled = false
      emit({ _tag: "RunStarted" })
      try {
        const expectedEcho = buildSubagentExecutionPrompt({
          mode: task.mode ?? "build",
          title: task.title,
          prompt: task.prompt,
        })
        const startupDeadline = Date.now() + Math.min(startupTimeoutMs, ORCA_WAIT_TIMEOUT_MS)
        let output = ""
        let ready = false
        while (!ready && (output === "" || Date.now() < startupDeadline)) {
          output = await collectTurnOutput()
          if (turn !== generation || state.closed) return
          ready = hasMeaningfulOutput(output, [expectedEcho])
        }
        if (turn !== generation || state.closed) return
        if (!ready) {
          emit({
            _tag: "RunSettled",
            outcome: failedOutcome(`Reattached terminal produced no readable output beyond the launch prompt within ${Math.round(startupTimeoutMs / 1000)}s. This failure is retryable with subagent_retry in the same worktree.`),
          })
          return
        }
        if (output) emit({ _tag: "AssistantMessage", parts: [{ type: "text", text: output }] })
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Completed", finalText: output || "Reattached Orca Pi terminal became idle without readable output." },
        })
      } catch (error) {
        if (turn !== generation || state.closed) return
        const message = boundedError(error)
        emit({ _tag: "BackendError", message })
        emit({ _tag: "RunSettled", outcome: failedOutcome(message) })
      } finally {
        if (turn === generation) {
          state.running = false
          state.settled = true
        }
      }
    }

    emit({ _tag: "MetaChanged", meta })
    if (options.observeExisting) {
      void observeExistingTurn()
    } else if (options.startPrompt !== false) {
      void runTurn(buildSubagentExecutionPrompt({
        mode: task.mode ?? "build",
        title: task.title,
        prompt: task.prompt,
      }))
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true
        if (!state.settled && activeTerminal) {
          try {
            await adapter.stop(task.jobId!)
          } catch {
            // best effort; the terminal status remains externally observable
          }
        }
        Queue.endUnsafe(events)
      }),
    )

    return {
      meta: Effect.succeed(meta),
      events: Stream.fromQueue(events),
      send: (text) => Effect.suspend(() => {
        if (state.closed) return new SendError({ message: "Orca Pi terminal session is closed." })
        if (state.running) return new SendError({ message: "Orca Pi terminal session is busy." })
        void runTurn(text)
        return Effect.void
      }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return
        const wasActive = state.running || !state.settled
        generation++
        if (activeTerminal) {
          try {
            await adapter.stop(task.jobId!)
          } catch (error) {
            emit({ _tag: "BackendError", message: boundedError(error) })
          }
        }
        activeTerminal = undefined
        if (wasActive) emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } })
        state.settled = true
        state.running = false
      }),
      probeStatus: Effect.promise(() => adapter.probe(task.jobId!)),
    }
  })

export function makeOrcaBackend(cli: OrcaSessionClient = new OrcaCli(), options: OrcaBackendOptions = {}): SubagentBackend {
  const stableIdleMs = options.stableIdleMs ?? ORCA_STABLE_IDLE_DEFAULT_MS
  const startupTimeoutMs = options.startupTimeoutMs ?? ORCA_STARTUP_TIMEOUT_DEFAULT_MS
  return {
    name: "orca",
    capabilities: { steering: false, modelSelection: false, reasoningEffort: false },
    available: Effect.promise(async () => {
      try {
        await cli.listTerminals()
        return true
      } catch {
        return false
      }
    }),
    spawn: (task) => makeOrcaSession(task, cli, {
      ...(task.initialTerminal ? { initialTerminal: task.initialTerminal, promptAlreadySent: true } : {}),
      stableIdleMs,
      startupTimeoutMs,
    }),    reattach: (task, identity) => Effect.gen(function* () {
      if (!identity.nativeTerminalHandle || !identity.nativeWorktreeId) {
        return yield* new SpawnError({ message: "Orca reattach requires terminal and worktree identity." })
      }
      const terminal = yield* Effect.tryPromise({
        try: async () => {
          const terminals = await cli.listTerminals(identity.nativeWorktreeId!)
          const found = terminals.find((item) => item.handle === identity.nativeTerminalHandle)
          if (!found || !found.connected || found.orphaned || found.worktreeId !== identity.nativeWorktreeId) {
            throw new Error("Orca terminal is missing, disconnected, orphaned, or bound to another worktree.")
          }
          const identityFields = [
            ["tab", identity.nativeTabId, found.tabId],
            ["pane", identity.nativePaneKey, found.paneKey],
            ["session", identity.nativeSessionId, found.sessionId],
            ["launch", identity.nativeLaunchToken, found.launchToken],
          ] as const
          for (const [label, expected, actual] of identityFields) {
            if (expected !== undefined && actual !== expected) {
              throw new Error(`Orca ${label} identity changed; refusing reattach.`)
            }
          }
          return {
            handle: found.handle,
            worktreeId: found.worktreeId,
            ...(found.tabId === undefined ? {} : { tabId: found.tabId }),
            ...(identity.nativePaneKey === undefined ? {} : { paneKey: identity.nativePaneKey }),
            ...(identity.nativeSessionId === undefined ? {} : { sessionId: identity.nativeSessionId }),
            ...(identity.nativeLaunchToken === undefined ? {} : { launchToken: identity.nativeLaunchToken }),
          } satisfies OrcaCreatedTerminal
        },
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      })
      return yield* makeOrcaSession(task, cli, { initialTerminal: terminal, startPrompt: false, observeExisting: true, stableIdleMs, startupTimeoutMs })
    }),
  }
}

export const orcaBackend: SubagentBackend = makeOrcaBackend()
