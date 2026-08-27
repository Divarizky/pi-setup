/**
 * pi backend — real implementation over the pi SDK.
 *
 * Written fresh; semantically equivalent to the reference but not a copy.
 */

import * as path from "node:path";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  SubagentMode,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { buildSubagentExecutionPrompt } from "../prompt.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_QUEUED_PROMPTS = 16;
const MAX_QUEUED_PROMPT_BYTES = 256 * 1024;

/** Tools headless children must not receive. */
const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "subagent_approve",
  "subagent_action_list",
  "subagent_action_confirm",
  "subagent_retry",
  "subagent_retire",
  "subagent_delete",
  "subagent_lead_create",
  "subagent_lead_send",
  "subagent_lead_stop",
  "workflow",
  "ask_user",
  "bg_start",
  "bg_stop",
  "bg_list",
  "fd",
  "rg",
] as const;

const SCOUT_EXCLUDED_TOOL_NAMES = ["bash", "edit", "write"] as const;

export function excludedToolsForMode(mode: SubagentMode) {
  return mode === "scout"
    ? [...CHILD_EXCLUDED_TOOL_NAMES, ...SCOUT_EXCLUDED_TOOL_NAMES]
    : [...CHILD_EXCLUDED_TOOL_NAMES];
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

function resolvePiModel(
  registry: ModelRegistry,
  hint: string | undefined,
  inherited: { readonly provider: string; readonly id: string } | undefined,
): Model<any> | undefined {
  if (!hint) {
    if (!inherited) return undefined;
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((m) => m.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

async function createChildResources(
  cwd: string,
  projectTrusted: boolean,
  parentRegistry: ModelRegistry,
  parentModel: Model<any> | undefined,
) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();

  // Headless children intentionally do not load project extensions, but a
  // selected model may come from a trusted parent-registered provider (such as
  // 9router). Rehydrate only that provider's already-registered config into a
  // child runtime; this keeps provider credentials in memory and does not run
  // arbitrary extension code in the child.
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  if (parentModel) {
    const providerConfig = parentRegistry.getRegisteredProviderConfig(
      parentModel.provider,
    );
    if (providerConfig)
      modelRuntime.registerProvider(parentModel.provider, providerConfig);
  }
  const model = parentModel
    ? (modelRuntime.getModel(parentModel.provider, parentModel.id) ??
      parentModel)
    : undefined;
  return { loader, settingsManager, modelRuntime, model };
}

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => undefined)
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function shutdownAndDisposeChildSession(session: AgentSession) {
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await waitBounded(
        session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        }),
        CHILD_SHUTDOWN_TIMEOUT_MS,
      );
    }
  } catch {
    // best-effort
  } finally {
    try {
      session.dispose();
    } catch {
      // idempotent
    }
  }
}

function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

function lastAssistantMessage(
  session: AgentSession,
): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

function finalOutput(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text.slice(0, 4096);
  } catch {
    return undefined;
  }
}

function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : (part.thinking ?? ""),
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: part.id ?? "",
        name: part.name ?? "",
        argsPreview: safeJson(
          (part as unknown as { arguments?: unknown }).arguments,
        ),
      });
    }
  }
  return parts;
}

function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

const makePiSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry) {
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    }

    const model = yield* Effect.try({
      try: () =>
        resolvePiModel(registry, task.model, task.parent.inheritedModel),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const thinkingLevel =
      task.reasoningEffort ?? task.parent.inheritedThinkingLevel;

    const session = yield* Effect.tryPromise({
      try: async () => {
        const {
          loader,
          settingsManager,
          modelRuntime,
          model: childModel,
        } = await createChildResources(
          task.cwd,
          task.parent.projectTrusted,
          registry,
          model,
        );
        const { session } = await createAgentSession({
          cwd: task.cwd,
          sessionManager: task.sessionFilePath
            ? SessionManager.open(task.sessionFilePath, undefined, task.cwd)
            : SessionManager.create(task.cwd),
          settingsManager,
          resourceLoader: loader,
          modelRuntime,
          model: childModel,
          thinkingLevel,
          excludeTools: excludedToolsForMode(task.mode ?? "build"),
        });
        // Child sessions intentionally do not bind project extensions. This
        // prevents untrusted project code from adding tools or event handlers
        // to a headless subagent.
        return session;
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const state = {
      closed: false,
      runError: undefined as string | undefined,
      settled: false,
      queuedPromptCount: 0,
      queuedPromptBytes: 0,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const activeModel = (): Model<any> | undefined => {
      const sessionModel = session.model;
      const last = lastAssistantMessage(session);
      if (!last) return sessionModel;
      if (
        sessionModel &&
        (last.provider !== sessionModel.provider ||
          last.model !== sessionModel.id)
      ) {
        return sessionModel;
      }
      return (
        registry.find(last.provider, last.responseModel ?? last.model) ??
        sessionModel
      );
    };

    const currentMeta = (): SubagentMeta => {
      const m = activeModel();
      return {
        backend: "pi",
        modelLabel: m ? `${m.provider}/${m.id}` : undefined,
        contextWindow: m?.contextWindow,
        sessionFilePath: session.sessionFile,
        nativeSessionId: session.sessionId,
      };
    };

    emit({ _tag: "MetaChanged", meta: currentMeta() });

    const emitUsage = () => {
      const usage = session.getContextUsage();
      emit({
        _tag: "UsageChanged",
        tokens: usage?.tokens ?? undefined,
        contextWindow: activeModel()?.contextWindow ?? usage?.contextWindow,
      });
    };

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      const last = lastAssistantMessage(session);
      const partialText = finalOutput(session) || undefined;
      if (last?.stopReason === "aborted") {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Interrupted", partialText },
        });
        return;
      }
      const errorText =
        state.runError ??
        (last?.stopReason === "error"
          ? (last.errorMessage ?? "Run failed")
          : undefined);
      if (errorText !== undefined) {
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Failed",
            errorText: boundedError(errorText),
            partialText,
          },
        });
        return;
      }
      emit({
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: finalOutput(session) },
      });
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (state.closed) return;
      switch (event.type) {
        case "agent_start":
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent?.type === "text_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: streamEvent.delta ?? "",
            });
          } else if (streamEvent?.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: streamEvent.delta ?? "",
            });
          }
          break;
        }
        case "message_end": {
          const role = messageRole(event.message);
          if (role === "user") {
            const text = userText(event.message as Message);
            if (text.trim()) emit({ _tag: "UserMessage", text });
          } else if (role === "assistant") {
            emit({
              _tag: "AssistantMessage",
              parts: assistantParts(event.message as AssistantMessage),
            });
            emitUsage();
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          break;
        }
        case "tool_execution_start":
          emit({
            _tag: "ToolStart",
            toolId: event.toolCallId ?? "",
            name: event.toolName ?? "",
            argsPreview: safeJson(event.args),
          });
          break;
        case "tool_execution_update":
          emit({
            _tag: "ToolUpdate",
            toolId: event.toolCallId ?? "",
            outputPreview: toolPreview(event.partialResult),
          });
          break;
        case "tool_execution_end":
          emit({
            _tag: "ToolEnd",
            toolId: event.toolCallId ?? "",
            name: event.toolName ?? "",
            isError: event.isError ?? false,
            outputPreview: toolPreview(event.result),
          });
          break;
        case "queue_update": {
          const queued = [
            ...(event.steering ?? []).map((text) => ({
              text,
              kind: "steer" as const,
            })),
            ...(event.followUp ?? []).map((text) => ({
              text,
              kind: "follow-up" as const,
            })),
          ];
          state.queuedPromptCount = queued.length;
          state.queuedPromptBytes = queued.reduce(
            (total, item) => total + Buffer.byteLength(item.text, "utf8"),
            0,
          );
          emit({ _tag: "QueueChanged", queued });
          break;
        }
        case "agent_settled":
          settle();
          break;
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        unsubscribe();
        try {
          session.clearQueue();
        } catch {
          // continue
        }
        await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS);
        await shutdownAndDisposeChildSession(session);
        Queue.endUnsafe(events);
      }),
    );

    const startRun = (text: string) => {
      state.runError = undefined;
      state.settled = false;
      void session.prompt(text).catch((error) => {
        state.runError = boundedError(error);
        // Always settle on prompt rejection. A stale streaming flag must not
        // leave the manager waiting forever.
        settle();
      });
    };

    yield* Effect.try(() =>
      session.sessionManager.appendSessionInfo(
        `${task.origin === "quick-ask" ? "quick-ask" : "subagent"}: ${task.title}`,
      ),
    ).pipe(Effect.ignore);

    emit({ _tag: "MetaChanged", meta: currentMeta() });
    startRun(
      buildSubagentExecutionPrompt({
        mode: task.mode ?? "build",
        title: task.title,
        prompt: task.prompt,
      }),
    );

    return {
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (text.length > 32_000) {
            return new SendError({
              message: "Subagent prompt exceeds the 32,000-character limit.",
            });
          }
          if (session.isStreaming) {
            const bytes = Buffer.byteLength(text, "utf8");
            if (
              state.queuedPromptCount >= MAX_QUEUED_PROMPTS ||
              state.queuedPromptBytes + bytes > MAX_QUEUED_PROMPT_BYTES
            ) {
              return new SendError({
                message: "Subagent prompt queue is full.",
              });
            }
            return Effect.tryPromise({
              try: async () => {
                await session.steer(text);
                state.queuedPromptCount++;
                state.queuedPromptBytes += bytes;
              },
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        try {
          session.clearQueue();
        } catch {
          // continue
        }
        await session.abort().catch(() => undefined);
        while (!state.closed && session.isStreaming) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        }
      }),
    } satisfies SubagentSession;
  });

export const piBackend: SubagentBackend = {
  name: "pi",
  capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
  available: Effect.succeed(true),
  spawn: makePiSession,
};
