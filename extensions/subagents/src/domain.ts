/**
 * Domain model for subagents.
 *
 * Normalized types shared by backends, manager, tools, and UI.
 * Each backend translates its native stream into the `SubagentEvent` union.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";
import type { SubagentWorktree } from "./worktree.ts";

export const BACKEND_NAMES = ["pi", "orca"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export type SubagentOrigin = "model" | "quick-ask";

/** Canonical identity vocabulary: execution, workflow, proposal, and owner. */
export type SubagentJobId = string;
export type WorkflowTaskId = string;
export type LeadAgentId = string;
export type LeadAgentProposalId = string;

export const SUBAGENT_MODES = ["scout", "build"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];
/** Internal compatibility values: `worker` is a Subagent, `lead` is an Agent Lead. */
export type SubagentRole = "worker" | "lead";

export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "failed";

export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: ReasoningEffort;
  readonly modelRegistry?: ModelRegistry;
  /** Durable state namespace of the parent runtime that owns this child. */
  readonly parentStateRoot?: string;
  /** Coordinator root used for Lead-to-parent event delivery. */
  readonly coordinatorStateRoot?: string;
}

export interface SubagentInitialTerminal {
  readonly handle: string;
  readonly worktreeId?: string;
  readonly tabId?: string;
  readonly paneKey?: string;
  readonly sessionId?: string;
  readonly launchToken?: string;
}

export interface SpawnTask {
  /** Optional id allocated before backend spawn so terminal bindings use the durable job id. */
  readonly jobId?: SubagentJobId;
  /** Developer-facing conventional branch name; distinct from the durable job id. */
  readonly branchName?: string;
  readonly origin?: SubagentOrigin;
  /** Controls which orchestration tools a child session may receive. */
  readonly role?: SubagentRole;
  /** Lead Agent that owns this execution, when it was proposed by a lead. */
  readonly leadAgentId?: LeadAgentId;
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  readonly worktree?: SubagentWorktree;
  /** Terminal already launched by Orca's agent-first worktree command. */
  readonly initialTerminal?: SubagentInitialTerminal;
  readonly mode?: SubagentMode;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  /** Optional persisted Pi session file for an Agent Lead reopen. */
  readonly sessionFilePath?: string;
  /** Optional session directory; Agent Leads use a dedicated durable home. */
  readonly sessionDir?: string;
  readonly parent: ParentContext;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  readonly role?: SubagentRole;
  /** Lead Agent that owns this execution, used by the dashboard hierarchy. */
  readonly leadAgentId?: LeadAgentId;
  readonly worktree?: SubagentWorktree;
  readonly mode?: SubagentMode;
  readonly modelLabel?: string;
  readonly contextWindow?: number;
  readonly sessionFilePath?: string;
  readonly nativeSessionId?: string;
  /** Native terminal/worktree identity used by external session hosts such as Orca. */
  readonly nativeTerminalHandle?: string;
  readonly nativeWorktreeId?: string;
  readonly nativeTabId?: string;
  readonly nativePaneKey?: string;
  readonly nativeLaunchToken?: string;
  /** Durable parent namespace used by in-process child extensions. */
  readonly parentStateRoot?: string;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ----------------------------------------------------------------

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string }
  | {
      readonly _tag: "TimedOut";
      readonly timeoutMs: number;
      readonly partialText?: string;
    };

export type SubagentEvent =
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      readonly tokens?: number;
      readonly contextWindow?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

export type ReportOutcome =
  "success" | "failed" | "blocked" | "timeout" | "cancelled";

export interface SubagentErrorReport {
  readonly phase:
    "analysis" | "implementation" | "test" | "environment" | "runtime";
  readonly message: string;
  readonly cause?: string;
  readonly recovery?: string;
}

export interface SubagentReport {
  readonly outcome: ReportOutcome;
  readonly summary: string;
  readonly changes: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<{
    readonly command: string;
    readonly passed: boolean;
    readonly output?: string;
  }>;
  readonly error?: SubagentErrorReport;
  readonly needsParentDecision: boolean;
}

export interface SubagentEventLog {
  readonly at: number;
  readonly event: string;
  readonly message?: string;
}

export interface SubagentMetrics {
  readonly runCount: number;
  readonly restartCount: number;
  readonly timeoutCount: number;
  readonly startedAt: number;
  readonly lastEventAt: number;
}

export interface SubagentSnapshot {
  /** Public compatibility name; this value is always the durable SubagentJobId. */
  readonly id: SubagentJobId;
  readonly origin: SubagentOrigin;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly status: SubagentStatus;
  /** True while a follow-up/retry is being dispatched after settlement. */
  readonly restarting?: boolean;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly report?: SubagentReport;
  readonly metrics: SubagentMetrics;
  readonly eventLog: ReadonlyArray<SubagentEventLog>;
  readonly meta: SubagentMeta;
  readonly usage: { readonly tokens?: number; readonly contextWindow?: number };
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  readonly finalText: string;
  readonly turns: number;
}

/** True while the first run has started but no transcript/output evidence exists yet. */
export function isSubagentBooting(snap: SubagentSnapshot): boolean {
  return (
    snap.status === "running" &&
    snap.restarting !== true &&
    snap.metrics.runCount <= 1 &&
    snap.transcript.length === 0 &&
    snap.liveAssistant === undefined &&
    snap.liveTools.length === 0
  );
}

export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

// --- Errors -----------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
