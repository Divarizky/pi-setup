import type { AgentConfig } from "../types.js";

export type TaskMode = "scout" | "ship";
export type TaskPolicy = TaskMode | "flexible";

export const SCOUT_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

const DEFAULT_TASK_POLICIES: Readonly<Record<string, TaskPolicy>> = {
  explore: "scout",
  build: "ship",
  general: "flexible",
};

export interface TaskPolicyInput {
  enabled: boolean;
  agentType: string;
  requestedMode?: unknown;
  agentConfig?: AgentConfig;
}

export type TaskPolicyResolution =
  | { enabled: false }
  | { enabled: true; policy: TaskPolicy; mode: TaskMode }
  | { enabled: true; ok: false; message: string };

export function resolveTaskPolicy(input: TaskPolicyInput): TaskPolicyResolution {
  if (!input.enabled) return { enabled: false };

  const policy = input.agentConfig?.taskPolicy ?? DEFAULT_TASK_POLICIES[input.agentType.toLowerCase()];
  if (!policy) {
    return {
      enabled: true,
      ok: false,
      message: `Agent type "${input.agentType}" must declare task_policy: "scout", "ship", or "flexible".`,
    };
  }

  const requested = input.requestedMode;
  if (requested !== undefined && requested !== "scout" && requested !== "ship") {
    return {
      enabled: true,
      ok: false,
      message: `Invalid task_mode "${String(requested)}". Use "scout" or "ship".`,
    };
  }

  if (policy === "flexible") {
    if (requested === undefined) {
      return {
        enabled: true,
        ok: false,
        message: `Agent type "${input.agentType}" requires task_mode: "scout" or "ship" when Agent Control is enabled.`,
      };
    }
    return { enabled: true, policy, mode: requested };
  }

  if (requested !== undefined && requested !== policy) {
    return {
      enabled: true,
      ok: false,
      message: `Agent type "${input.agentType}" has fixed task policy "${policy}" and cannot run as "${requested}".`,
    };
  }

  return { enabled: true, policy, mode: policy };
}
