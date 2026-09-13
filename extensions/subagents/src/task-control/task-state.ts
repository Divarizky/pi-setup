import type { ValidationEvidence } from "../core/worktree.js";
import type { TaskMode, TaskPolicy } from "./task-policy.js";

export type ApprovalDecision = "approved" | "rejected";

export interface CandidateApproval {
  actor: "user";
  decision: ApprovalDecision;
  taskId: string;
  candidateBranch: string;
  candidateSha: string;
  targetBranch: string;
  targetSha: string;
  decidedAt: number;
}

export type TaskStatus =
  | "preparing"
  | "running"
  | "completed"
  | "completed_no_changes"
  | "failed"
  | "interrupted"
  | "candidate_ready"
  | "validation_failed"
  | "recovery_required"
  | "rejected"
  | "integrating"
  | "integration_conflict"
  | "integrated"
  | "integrated_unrecorded";

export interface TaskRecord {
  id: string;
  mode: TaskMode;
  policy: TaskPolicy;
  agentType: string;
  objective: string;
  repositoryPath: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** Contract fields are populated for ship tasks and optional for scouts. */
  baseSha?: string;
  targetBranch?: string;
  writeScope?: string[];
  acceptanceCriteria?: string[];
  validationCommands?: string[];
  candidateBranch?: string;
  candidateSha?: string;
  changedFiles?: string[];
  validationEvidence?: ValidationEvidence[];
  approval?: CandidateApproval;
  integrationCommitSha?: string;
  integrationValidationEvidence?: ValidationEvidence[];
  worktreePath?: string;
  agentId?: string;
  error?: string;
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  preparing: ["running", "failed", "interrupted"],
  running: [
    "completed",
    "completed_no_changes",
    "failed",
    "interrupted",
    "candidate_ready",
    "validation_failed",
    "recovery_required",
  ],
  completed: [],
  completed_no_changes: [],
  failed: ["recovery_required"],
  interrupted: ["preparing", "candidate_ready", "recovery_required", "failed", "validation_failed", "completed_no_changes"],
  candidate_ready: ["integrating", "rejected", "recovery_required"],
  validation_failed: ["recovery_required", "rejected"],
  recovery_required: ["preparing", "candidate_ready", "rejected"],
  rejected: [],
  integrating: ["integrated", "integrated_unrecorded", "integration_conflict", "failed", "interrupted"],
  integration_conflict: ["recovery_required", "rejected"],
  integrated: [],
  integrated_unrecorded: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionTask(
  task: TaskRecord,
  next: TaskStatus,
  reason: string,
  timestamp: number,
): TaskRecord {
  if (!canTransitionTask(task.status, next)) {
    throw new Error(`Invalid task transition: "${task.status}" -> "${next}".`);
  }

  return {
    ...task,
    status: next,
    updatedAt: timestamp,
    ...(reason ? { error: next === "failed" || next === "validation_failed" ? reason : task.error } : {}),
  };
}
