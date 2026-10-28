import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getEffectiveDocExtensions,
  getEffectiveValidationPatterns,
  getJudgeMode,
  getNestedJudgeSettings,
} from "./config.ts";
import {
  createInitialState,
  evaluateRun,
  extractShellCommand,
  isTrackedEditPath,
  isValidationCommand,
  recordEdit,
  recordValidation,
  type TaskJudgeState,
} from "./judge.ts";
import { appendJudgeLog } from "./logger.ts";
import {
  type CompletionLike,
  extractText,
  runNestedJudge,
} from "./nested-judge.ts";

async function judgeNested(
  state: TaskJudgeState,
  event: AgentBeforeSettleEvent,
  ctx: ExtensionContext,
) {
  try {
    return await runJudgeNested(state, event, ctx);
  } catch (err) {
    // Fail-open: kegagalan judge lapis 2 tidak boleh menimpa keputusan lapis 1
    return {
      verdict: "tidak_diketahui" as const,
      reason: (err as Error)?.message ?? "error",
      model: "",
      elapsedMs: 0,
      timedOut: false,
    };
  }
}

async function runJudgeNested(
  state: TaskJudgeState,
  event: AgentBeforeSettleEvent,
  ctx: ExtensionContext,
) {
  const settings = getNestedJudgeSettings();
  if (!settings.enabled) return undefined;
  const model = ctx.modelRegistry.find(settings.provider, settings.modelId);
  const label = `${settings.provider}:${settings.modelId}`;
  if (!model) {
    return {
      verdict: "tidak_diketahui" as const,
      reason: "model_not_found",
      model: label,
      elapsedMs: 0,
      timedOut: false,
    };
  }
  const editedPaths = [...new Set(state.edits.map((e) => e.path))];
  const validationCommands = state.validations.map((v) => v.command);
  const lastAssistantText = lastAssistantTextOf(event.context.llmMessages);
  const result = await runNestedJudge(
    { editedPaths, validationCommands, lastAssistantText },
    (prompt, signal) =>
      ctx.modelRegistry.complete(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { signal },
      ) as Promise<CompletionLike>,
    settings.timeoutMs,
    ctx.signal,
  );
  return { ...result, model: label };
}

function lastAssistantTextOf(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    return extractText(m.content);
  }
  return "";
}

export default function taskJudgeExtension(pi: ExtensionAPI): void {
  let state: TaskJudgeState = createInitialState();

  pi.on("agent_start", (_event: AgentStartEvent, _ctx: ExtensionContext) => {
    state = createInitialState();
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    try {
      if (event.toolName === "edit" || event.toolName === "write") {
        const path = event.input?.path;
        if (
          !event.isError &&
          typeof path === "string" &&
          isTrackedEditPath(path, ctx.cwd)
        ) {
          state = recordEdit(state, path);
        }
      } else {
        const command = extractShellCommand(event.toolName, event.input);
        const patterns = getEffectiveValidationPatterns();
        if (command && isValidationCommand(command, patterns)) {
          state = recordValidation(state, command, !event.isError);
        }
      }
    } catch (err) {
      // Fail-closed: jangan melempar error
      console.warn(`task-judge: tool_result error — ${(err as Error).message}`);
    }
  });

  pi.on(
    "agent_before_settle",
    async (
      event: AgentBeforeSettleEvent,
      ctx: ExtensionContext,
    ): Promise<AgentBeforeSettleEventResult | void> => {
      try {
        // Bila run dibatalkan user, tidak bertindak
        if (event.outcome === "aborted") {
          return;
        }

        // Di subagent (child session) bila terdeteksi parentSession pada header sessionManager
        const header = ctx.sessionManager?.getHeader?.();
        if (header?.parentSession) {
          return;
        }

        const mode = getJudgeMode();
        const docExtensions = getEffectiveDocExtensions();
        const validationPatterns = getEffectiveValidationPatterns();

        const evaluation = evaluateRun(state, {
          docExtensions,
          validationPatterns,
        });
        const sessionId = ctx.sessionManager?.getSessionId?.();

        // Judge lapis 2: hanya untuk run tidak terverifikasi, bukan mode off, opsional, fail-open.
        // Hasilnya dicatat saja dan tidak mengubah keputusan lapis 1.
        let nestedJudge: Awaited<ReturnType<typeof judgeNested>> | undefined;
        if (evaluation.decision === "tidak_terverifikasi" && mode !== "off") {
          nestedJudge = await judgeNested(state, event, ctx);
        }

        // Tulis log durable untuk setiap keputusan run
        appendJudgeLog({
          timestamp: new Date().toISOString(),
          sessionId,
          decision: evaluation.decision,
          editCount: evaluation.editCount,
          hasSuccessfulValidation: evaluation.hasSuccessfulValidation,
          mode,
          nestedJudge,
        });

        // Bila mode off, jangan lakukan notifikasi UI
        if (mode === "off") {
          return;
        }

        // Dalam mode warn: tampilkan notifikasi UI bila run tidak terverifikasi
        if (evaluation.decision === "tidak_terverifikasi") {
          ctx.ui.notify(
            "Peringatan task-judge: file diedit tanpa perintah validasi yang sukses setelah edit terakhir.",
            "warning",
          );
        }
      } catch (err) {
        // Fail-closed untuk pengambilan keputusan
        try {
          appendJudgeLog({
            timestamp: new Date().toISOString(),
            sessionId: ctx.sessionManager?.getSessionId?.(),
            decision: "dikecualikan",
            editCount: state?.edits?.length ?? 0,
            hasSuccessfulValidation: false,
            mode: getJudgeMode(),
            error: (err as Error).message,
          });
        } catch {
          // Fail-safe jika penulisan log error gagal
        }
      }
    },
  );
}
