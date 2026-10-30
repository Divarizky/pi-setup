import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  claimContinuation,
  createFailureState,
  type FailureConfig,
  type FailureState,
  isEmptyStop,
  parseConfig,
  registerToolCall,
  registerToolResult,
  renderTemplate,
} from "./detectors.ts";

const templatesPath = new URL("./templates.json", import.meta.url);
const templates = JSON.parse(readFileSync(templatesPath, "utf8")) as Record<
  string,
  string
>;

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (!xdg) return join(homedir(), ".config");
  const expanded = expandTilde(xdg);
  return isAbsolute(expanded) ? expanded : join(homedir(), ".config");
}

function loadConfig(): FailureConfig {
  const path = join(resolveConfigDir(), "failure-recovery", "config.json");
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // File tidak ada atau tidak valid: gunakan default
    return parseConfig({});
  }
}

export default function failureRecoveryExtension(pi: ExtensionAPI): void {
  let state: FailureState = createFailureState();

  // before_agent_start hanya terpanggil untuk run baru (user atau custom), bukan
  // continuation (agent.continue()). Penghitung continuation karena itu bertahan
  // di dalam satu run dan direset di sini.
  pi.on("before_agent_start", (_event: BeforeAgentStartEvent) => {
    state = createFailureState();
  });

  // Detektor loop: blokir panggilan identik ke-N berturut-turut
  pi.on(
    "tool_call",
    (event: ToolCallEvent, _ctx: ExtensionContext): ToolCallEventResult | void => {
      try {
        const config = loadConfig();
        if (!config.loop.enabled) return;
        const blocked = registerToolCall(
          state,
          event.toolName,
          event.input,
          config.loop.threshold,
        );
        if (blocked) {
          return {
            block: true,
            reason: renderTemplate(templates.loop, { tool: event.toolName }),
          };
        }
      } catch {
        // Fail-open: error detektor tidak boleh menghentikan tool atau run
      }
    },
  );

  // Detektor error beruntun: anotasi hasil tool
  pi.on(
    "tool_result",
    (event: ToolResultEvent, _ctx: ExtensionContext): ToolResultEventResult | void => {
      try {
        const config = loadConfig();
        if (!config.consecutiveErrors.enabled) return;
        const annotate = registerToolResult(
          state,
          event.isError,
          config.consecutiveErrors.threshold,
        );
        if (annotate) {
          const note = renderTemplate(templates.consecutiveErrors, {
            count: String(state.errorStreak),
          });
          return {
            content: [...event.content, { type: "text", text: `\n${note}` }],
            // Pi menghapus structuredContent bila hanya content yang diganti
            structuredContent: event.structuredContent,
          };
        }
      } catch {
        // Fail-open: error detektor tidak boleh menghentikan tool atau run
      }
    },
  );

  // Detektor berhenti kosong: maksimal emptyStop.maxRetries continuation per run
  pi.on(
    "agent_before_settle",
    (
      event: AgentBeforeSettleEvent,
      _ctx: ExtensionContext,
    ): AgentBeforeSettleEventResult | void => {
      try {
        if (event.outcome === "aborted") return;
        const config = loadConfig();
        if (!config.emptyStop.enabled) return;
        if (!isEmptyStop(event.context.llmMessages)) return;
        if (!claimContinuation(state, config.emptyStop.maxRetries)) return;
        return {
          entries: [
            {
              type: "custom_message",
              customType: "failure-recovery",
              content: templates.emptyStop,
              display: false,
            },
          ],
          continue: true,
        };
      } catch {
        // Fail-open: error detektor tidak boleh menghentikan tool atau run
      }
    },
  );
}
