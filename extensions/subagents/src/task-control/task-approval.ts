import type { CandidateApproval, TaskRecord } from "./task-state.js";

export type ApprovalValidation =
  | { ok: true }
  | { ok: false; reason: string };

function requireCandidateIdentity(task: TaskRecord): {
  candidateBranch: string;
  candidateSha: string;
  targetBranch: string;
  targetSha: string;
} {
  if (!task.candidateBranch || !task.candidateSha) {
    throw new Error("Cannot approve a task without a verified candidate branch and candidate SHA.");
  }
  if (!task.targetBranch || !task.baseSha) {
    throw new Error("Cannot approve a candidate without a target branch and target SHA.");
  }
  return {
    candidateBranch: task.candidateBranch,
    candidateSha: task.candidateSha,
    targetBranch: task.targetBranch,
    targetSha: task.baseSha,
  };
}

/** Capture only the state shown to the user by the approval dialog. */
export function captureCandidateApproval(
  task: TaskRecord,
  decision: CandidateApproval["decision"],
  decidedAt: number,
): CandidateApproval {
  if (task.status !== "candidate_ready") {
    throw new Error(`Cannot approve task ${task.id} while it is ${task.status}.`);
  }
  return {
    actor: "user",
    decision,
    taskId: task.id,
    ...requireCandidateIdentity(task),
    decidedAt,
  };
}

/**
 * Validate the durable task snapshot against the binding captured by the
 * confirmation dialog. Callers must run this before any Git mutation.
 */
export function validateCandidateApproval(
  task: TaskRecord,
  approval: CandidateApproval,
): ApprovalValidation {
  if (task.id !== approval.taskId) {
    return { ok: false, reason: "approval task ID is stale" };
  }
  if (task.candidateSha !== approval.candidateSha) {
    return { ok: false, reason: "candidate SHA changed; approval is stale" };
  }
  if (task.candidateBranch !== approval.candidateBranch) {
    return { ok: false, reason: "candidate branch changed; approval is stale" };
  }
  if (task.targetBranch !== approval.targetBranch) {
    return { ok: false, reason: "target branch changed; approval is stale" };
  }
  if (task.baseSha !== approval.targetSha) {
    return { ok: false, reason: "target SHA changed; approval is stale" };
  }
  if (!task.candidateBranch || !task.candidateSha || !task.targetBranch || !task.baseSha) {
    return { ok: false, reason: "candidate or target state is incomplete; approval is stale" };
  }
  return { ok: true };
}
