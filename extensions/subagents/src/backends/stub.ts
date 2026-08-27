/**
 * Scripted stub backend for manager tests.
 *
 * Streams a fake turn so streaming UI, wait, and footer counters are
 * observable. Not a copy of the reference implementation — written fresh.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Duration, Effect, Fiber, Queue, Ref, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  BackendName,
  QueuedMessage,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import { SendError } from "../domain.ts";

export interface StubProfile {
  readonly backend: BackendName;
  readonly defaultModelLabel: string;
  readonly contextWindow: number;
  readonly toolName: string;
  readonly cadenceMs: number;
}

const STUB_DIR = path.join(os.tmpdir(), "subagents-stub");
let sessionCounter = 0;

export function makeStubBackend(profile: StubProfile): SubagentBackend {
  return {
    name: profile.backend,
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (task) => makeStubSession(profile, task),
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const makeStubSession = (
  profile: StubProfile,
  task: SpawnTask,
): Effect.Effect<SubagentSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sessionId = `stub-${profile.backend}-${++sessionCounter}`;
    const sessionFile = path.join(STUB_DIR, `${sessionId}.jsonl`);

    const state = {
      meta: {
        backend: profile.backend,
        modelLabel: task.model ?? profile.defaultModelLabel,
        contextWindow: profile.contextWindow,
        sessionFilePath: sessionFile,
        nativeSessionId: sessionId,
      } satisfies SubagentMeta as SubagentMeta,
      pending: [] as string[],
      turnCount: 0,
      closed: false,
      dispatching: false,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const inbox = yield* Queue.make<string, Cause.Done>();
    const activeTurn = yield* Ref.make<Fiber.Fiber<void> | undefined>(
      undefined,
    );

    const emit = (event: SubagentEvent) =>
      Effect.suspend(() => {
        try {
          fs.appendFileSync(sessionFile, `${JSON.stringify(event)}\n`);
        } catch {
          // best-effort session file
        }
        if (event._tag === "MetaChanged") {
          state.meta = { ...state.meta, ...event.meta };
        }
        return Queue.offer(events, event);
      }).pipe(Effect.asVoid);

    const pause = Effect.sleep(Duration.millis(profile.cadenceMs));

    const runTurn = (userText: string, turn: number) =>
      Effect.gen(function* () {
        yield* emit({ _tag: "RunStarted" });
        const failing = userText.trimStart().startsWith("FAIL:");

        const thinking = "Planning the approach...";
        for (const delta of chunks(thinking, 16)) {
          yield* emit({ _tag: "AssistantDelta", kind: "thinking", delta });
          yield* pause;
        }

        const toolId = `${sessionId}-tool-${turn}`;
        const argsPreview = `{"command":"ls ${task.cwd}"}`;
        yield* emit({
          _tag: "AssistantMessage",
          parts: [
            { type: "thinking", text: thinking },
            { type: "text", text: `I'll inspect the workspace first.` },
            { type: "toolCall", toolId, name: profile.toolName, argsPreview },
          ],
        });
        yield* emit({
          _tag: "ToolStart",
          toolId,
          name: profile.toolName,
          argsPreview,
        });
        yield* pause;
        yield* emit({
          _tag: "ToolUpdate",
          toolId,
          outputPreview: "src package.json",
        });
        yield* pause;
        yield* emit({
          _tag: "ToolEnd",
          toolId,
          name: profile.toolName,
          isError: false,
          outputPreview: "src package.json",
        });
        yield* emit({
          _tag: "UsageChanged",
          tokens: Math.min(profile.contextWindow, 2400 * (turn + 1)),
          contextWindow: profile.contextWindow,
        });

        if (failing) {
          yield* pause;
          yield* emit({
            _tag: "RunSettled",
            outcome: {
              _tag: "Failed",
              errorText: `[stub:${profile.backend}] task failed as requested`,
            },
          });
          return;
        }

        const finalText =
          `[stub:${profile.backend}] completed: ${firstLine(userText).slice(0, 200)}\n\n` +
          `This is a stubbed ${profile.backend} turn ${turn + 1}.\n\n` +
          `<subagent-report>{"outcome":"success","summary":"Stub task completed","changes":["updated test fixture"],"tests":[{"command":"stub test","passed":true}],"needsParentDecision":false}</subagent-report>`;
        for (const delta of chunks(finalText, 24)) {
          yield* emit({ _tag: "AssistantDelta", kind: "text", delta });
          yield* pause;
        }
        yield* emit({
          _tag: "AssistantMessage",
          parts: [{ type: "text", text: finalText }],
        });
        yield* emit({
          _tag: "UsageChanged",
          tokens: Math.min(profile.contextWindow, 2400 * (turn + 1) + 900),
          contextWindow: profile.contextWindow,
        });
        yield* emit({
          _tag: "RunSettled",
          outcome: { _tag: "Completed", finalText },
        });
      });

    const queuedView = (): ReadonlyArray<QueuedMessage> =>
      state.pending.map((text) => ({ text, kind: "steer" }));

    const driver = Effect.gen(function* () {
      while (true) {
        const text = yield* Queue.take(inbox);
        state.dispatching = true;
        state.pending.shift();
        yield* emit({ _tag: "QueueChanged", queued: queuedView() });
        yield* emit({ _tag: "UserMessage", text });
        const turn = state.turnCount++;
        const fiber = yield* Effect.forkChild(
          runTurn(text, turn).pipe(
            Effect.onInterrupt(() =>
              emit({
                _tag: "RunSettled",
                outcome: { _tag: "Interrupted" },
              }).pipe(Effect.ignore),
            ),
          ),
        );
        yield* Ref.set(activeTurn, fiber);
        state.dispatching = false;
        yield* Fiber.await(fiber);
        yield* Ref.set(activeTurn, undefined);
      }
    });
    yield* Effect.forkScoped(driver.pipe(Effect.ignore));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        state.closed = true;
        yield* Queue.end(inbox).pipe(Effect.ignore);
        yield* Queue.end(events).pipe(Effect.ignore);
      }),
    );

    const submit = (text: string) =>
      Effect.gen(function* () {
        if (state.closed) {
          return yield* new SendError({
            message: "Subagent session is closed.",
          });
        }
        state.pending.push(text);
        const busy = (yield* Ref.get(activeTurn)) !== undefined;
        if (busy) {
          yield* emit({ _tag: "QueueChanged", queued: queuedView() });
        }
        yield* Queue.offer(inbox, text);
      });

    yield* Effect.try(() => fs.mkdirSync(STUB_DIR, { recursive: true })).pipe(
      Effect.ignore,
    );
    yield* emit({ _tag: "MetaChanged", meta: state.meta });
    yield* submit(task.prompt).pipe(Effect.orDie);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: submit,
      interrupt: Effect.gen(function* () {
        const cleared = yield* Queue.clear(inbox).pipe(
          Effect.orElseSucceed(() => []),
        );
        state.pending = [];
        yield* emit({ _tag: "QueueChanged", queued: [] });
        while (true) {
          const fiber = yield* Ref.get(activeTurn);
          if (fiber) {
            yield* Fiber.interrupt(fiber);
            return;
          }
          if (!state.dispatching) {
            if (cleared.length > 0) {
              yield* emit({
                _tag: "RunSettled",
                outcome: { _tag: "Interrupted" },
              });
            }
            return;
          }
          yield* Effect.sleep(Duration.millis(5));
        }
      }),
    } satisfies SubagentSession;
  });
