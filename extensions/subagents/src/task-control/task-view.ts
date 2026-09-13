import type { ValidationEvidence } from "../core/worktree.js";
import { redactAndLimit } from "./delivery-validation.js";
import type { CandidateApproval, TaskRecord } from "./task-state.js";
import type { TaskSnapshot } from "./task-store.js";

export type ProcessViewStatus = "preparing" | "running" | "interrupted" | "finished";
export type ValidationViewStatus = "not_run" | "pending" | "passed" | "failed" | "timed_out";
export type CandidateViewStatus = "none" | "ready" | "retained" | "recovery_required";
export type DeliveryViewStatus = "not_delivered" | "pending_approval" | "integrating" | "integrated" | "rejected" | "conflict";

export interface TaskView {
  taskId: string;
  objective: string;
  status: TaskRecord["status"];
  processStatus: ProcessViewStatus;
  validationStatus: ValidationViewStatus;
  candidateStatus: CandidateViewStatus;
  deliveryStatus: DeliveryViewStatus;
  approval?: CandidateApproval;
  integrationCommitSha?: string;
  integrationValidationEvidence: ValidationEvidence[];
  repositoryPath: string;
  targetBranch?: string;
  /** The target checkout SHA captured by ship preflight (stored as baseSha). */
  targetSha?: string;
  baseSha?: string;
  candidateBranch?: string;
  candidateSha?: string;
  changedFiles: string[];
  validationEvidence: ValidationEvidence[];
  validationCommands: string[];
  worktreePath?: string;
  error?: string;
  hasCandidate: boolean;
  updatedAt: number;
}

function processStatus(status: TaskRecord["status"]): ProcessViewStatus {
  if (status === "preparing" || status === "running" || status === "interrupted") return status;
  return "finished";
}

function validationStatus(task: TaskRecord): ValidationViewStatus {
  if (task.status === "validation_failed") {
    return task.validationEvidence?.some(evidence => evidence.timedOut) ? "timed_out" : "failed";
  }
  if (!task.validationEvidence || task.validationEvidence.length === 0) return "not_run";
  if (task.validationEvidence.some(evidence => evidence.timedOut)) return "timed_out";
  if (task.validationEvidence.some(evidence => evidence.exitCode !== 0)) return "failed";
  if (task.status === "running" || task.status === "preparing") return "pending";
  return "passed";
}

function candidateStatus(task: TaskRecord): CandidateViewStatus {
  if (task.candidateBranch && task.candidateSha) {
    return task.status === "candidate_ready" ? "ready" : "retained";
  }
  return task.status === "recovery_required" ? "recovery_required" : "none";
}

function deliveryStatus(status: TaskRecord["status"]): DeliveryViewStatus {
  if (status === "candidate_ready") return "pending_approval";
  if (status === "integrating") return "integrating";
  if (status === "integrated" || status === "integrated_unrecorded") return "integrated";
  if (status === "rejected") return "rejected";
  if (status === "integration_conflict") return "conflict";
  return "not_delivered";
}

export function buildTaskView(task: TaskRecord): TaskView {
  return {
    taskId: task.id,
    objective: task.objective,
    status: task.status,
    processStatus: processStatus(task.status),
    validationStatus: validationStatus(task),
    candidateStatus: candidateStatus(task),
    deliveryStatus: deliveryStatus(task.status),
    approval: task.approval,
    integrationCommitSha: task.integrationCommitSha,
    integrationValidationEvidence: task.integrationValidationEvidence ?? [],
    repositoryPath: task.repositoryPath,
    targetBranch: task.targetBranch,
    targetSha: task.baseSha,
    baseSha: task.baseSha,
    candidateBranch: task.candidateBranch,
    candidateSha: task.candidateSha,
    changedFiles: task.changedFiles ?? [],
    validationEvidence: task.validationEvidence ?? [],
    validationCommands: task.validationCommands ?? [],
    worktreePath: task.worktreePath,
    error: task.error,
    hasCandidate: Boolean(task.candidateBranch && task.candidateSha),
    updatedAt: task.updatedAt,
  };
}

/** Build review rows from durable state; no in-memory AgentRecord is required. */
export function buildTaskViews(snapshot: TaskSnapshot): TaskView[] {
  return Object.values(snapshot.tasks)
    .map(buildTaskView)
    .sort((left, right) => {
      if (left.hasCandidate !== right.hasCandidate) return left.hasCandidate ? -1 : 1;
      return right.updatedAt - left.updatedAt;
    });
}

function shortSha(sha: string | undefined): string {
  return sha ? `${sha.slice(0, 12)}…` : "(none)";
}

function formatEvidence(evidence: ValidationEvidence): string {
  const outcome = evidence.timedOut ? "timeout" : `exit ${evidence.exitCode ?? "unknown"}`;
  const output = [evidence.stdout, evidence.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return `- ${evidence.command} — ${outcome}${output ? `\n  ${output.replace(/\r?\n/g, "\n  ")}` : ""}`;
}

export function formatTaskView(view: TaskView): string {
  const lines = [
    `Task: ${view.taskId}`,
    `Status: ${view.status}`,
    `Process status: ${view.processStatus}`,
    `Validation status: ${view.validationStatus}`,
    `Candidate status: ${view.candidateStatus}`,
    `Delivery status: ${view.deliveryStatus}`,
    `Objective: ${view.objective}`,
    `Repository: ${view.repositoryPath}`,
    `Target branch: ${view.targetBranch ?? "(none)"}`,
    `Target SHA: ${shortSha(view.targetSha)}`,
    `Candidate branch: ${view.candidateBranch ?? "(none)"}`,
    `Candidate SHA: ${view.candidateSha ?? "(none)"}`,
    `Changed files: ${view.changedFiles.length > 0 ? view.changedFiles.join(", ") : "(none)"}`,
    "Validation evidence:",
  ];
  if (view.validationEvidence.length === 0) lines.push("- (none)");
  else lines.push(...view.validationEvidence.map(formatEvidence));
  if (view.approval) {
    lines.push(`Approval: ${view.approval.decision} by ${view.approval.actor}`);
    lines.push(`Approval candidate SHA: ${shortSha(view.approval.candidateSha)}`);
    lines.push(`Approval target: ${view.approval.targetBranch} @ ${shortSha(view.approval.targetSha)}`);
  }
  if (view.integrationCommitSha) lines.push(`Integration commit SHA: ${view.integrationCommitSha}`);
  if (view.integrationValidationEvidence.length > 0) {
    lines.push("Integration validation evidence:");
    lines.push(...view.integrationValidationEvidence.map(formatEvidence));
  }
  if (view.worktreePath) lines.push(`Recoverable worktree: ${view.worktreePath}`);
  if (view.error) lines.push(`Error: ${redactAndLimit(view.error)}`);
  return lines.join("\n");
}

/** Headless runtime is deliberately read-only until the approval/integration slice exists. */
export function headlessIntegrationError(hasUI: boolean): string | undefined {
  return hasUI ? undefined : "Agent Control candidate integration is unavailable in headless mode; candidate review is read-only.";
}
