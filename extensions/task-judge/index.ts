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

        // Tulis log durable untuk setiap keputusan run
        appendJudgeLog({
          timestamp: new Date().toISOString(),
          sessionId,
          decision: evaluation.decision,
          editCount: evaluation.editCount,
          hasSuccessfulValidation: evaluation.hasSuccessfulValidation,
          mode,
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
