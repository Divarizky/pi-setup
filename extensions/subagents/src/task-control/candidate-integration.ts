import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ValidationEvidence } from "../core/worktree.js";
import { runValidationCommands } from "./delivery-validation.js";
import { validateCandidateApproval } from "./task-approval.js";
import type { TaskRecord } from "./task-state.js";
import type { TaskStore } from "./task-store.js";

const GIT_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 120_000;

export interface CandidateIntegrationInput {
  pi: ExtensionAPI;
  cwd: string;
  store: TaskStore;
  taskId: string;
  signal?: AbortSignal;
}

export type CandidateIntegrationResult =
  | { status: "integrated"; commitSha: string; validationEvidence: ValidationEvidence[] }
  | { status: "integration_conflict" | "failed"; error: string; validationEvidence?: ValidationEvidence[] };

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  const result = await pi.exec("git", args, {
    cwd,
    timeout,
    ...(signal ? { signal } : {}),
  });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

async function gitCheck(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await pi.exec("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (result.killed || (result.code !== 0 && result.code !== 1)) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.code === 0;
}

function validBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  if (branch.includes("..")) return false;
  if (branch.startsWith("-") || branch.startsWith(".") || branch.startsWith("/")) return false;
  if (branch.endsWith("/") || branch.endsWith(".lock")) return false;
  if (branch.includes("@{")) return false;
  return true;
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync.native(left).toLowerCase() === realpathSync.native(right).toLowerCase();
  } catch {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  }
}

function failure(status: "integration_conflict" | "failed", error: string, validationEvidence?: ValidationEvidence[]): CandidateIntegrationResult {
  return {
    status,
    error,
    ...(validationEvidence ? { validationEvidence } : {}),
  };
}

async function recordFailure(
  store: TaskStore,
  task: TaskRecord,
  status: "integration_conflict" | "failed",
  reason: string,
  validationEvidence: ValidationEvidence[] = [],
): Promise<CandidateIntegrationResult> {
  try {
    store.transitionWithPatch(task.id, status, reason, {
      integrationValidationEvidence: validationEvidence,
    });
  } catch (error) {
    return failure(status, `${reason}; durable integration outcome failed: ${error instanceof Error ? error.message : String(error)}`, validationEvidence);
  }
  return failure(status, reason, validationEvidence);
}

async function recordCommittedWithoutState(
  store: TaskStore,
  task: TaskRecord,
  integrationCommitSha: string,
  validationEvidence: ValidationEvidence[],
  cause: unknown,
): Promise<CandidateIntegrationResult> {
  try {
    store.transitionWithPatch(task.id, "integrated_unrecorded", "integration commit created but durable state could not be updated", {
      integrationCommitSha,
      integrationValidationEvidence: validationEvidence,
    });
  } catch (error) {
    return failure("failed", `Integration commit ${integrationCommitSha} was created but durable state could not be updated: ${cause instanceof Error ? cause.message : String(cause)}; follow-up state update also failed: ${error instanceof Error ? error.message : String(error)}`, validationEvidence);
  }
  return failure("failed", `Integration commit ${integrationCommitSha} was created but durable state could not be updated: ${cause instanceof Error ? cause.message : String(cause)}`, validationEvidence);
}

async function abortMerge(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    await git(pi, cwd, ["merge", "--abort"], signal, GIT_TIMEOUT_MS);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Integrate only the exact user-approved candidate. Every Git mutation happens
 * after clean checkout, target, approval, and candidate-ref checks succeed.
 */
export async function integrateApprovedCandidate(
  input: CandidateIntegrationInput,
): Promise<CandidateIntegrationResult> {
  let task: TaskRecord | undefined;
  try {
    task = input.store.load().tasks[input.taskId];
  } catch (error) {
    return failure("failed", `Unable to read durable task state: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!task) return failure("failed", `Task not found: ${input.taskId}`);
  if (task.status !== "candidate_ready") return failure("failed", `Task ${task.id} is ${task.status}; only candidate_ready tasks can be integrated.`);
  if (!task.approval || task.approval.decision !== "approved") return failure("failed", `Task ${task.id} has no user approval.`);

  const binding = validateCandidateApproval(task, task.approval);
  if (!binding.ok) return failure("failed", binding.reason);
  if (!validBranchName(task.approval.candidateBranch)) return failure("failed", "Approved candidate branch name is invalid.");

  let targetBranch: string;
  let targetSha: string;
  let candidateSha: string;
  try {
    const dirty = await git(input.pi, input.cwd, ["status", "--porcelain", "--untracked-files=all"], input.signal);
    if (dirty) return failure("failed", "Main checkout is dirty; integration was not started.");
    const repositoryRoot = await git(input.pi, input.cwd, ["rev-parse", "--show-toplevel"], input.signal);
    if (!samePath(repositoryRoot, task.repositoryPath)) {
      return failure("failed", "Integration repository does not match the task repository.");
    }
    targetBranch = await git(input.pi, input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"], input.signal);
    targetSha = await git(input.pi, input.cwd, ["rev-parse", "HEAD^{commit}"], input.signal);
    candidateSha = await git(
      input.pi,
      input.cwd,
      ["rev-parse", "--verify", `refs/heads/${task.approval.candidateBranch}^{commit}`],
      input.signal,
    );
  } catch (error) {
    return failure("failed", `Integration preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (targetBranch !== task.approval.targetBranch) {
    return failure("failed", "Target branch changed; approval is stale.");
  }
  if (targetSha !== task.approval.targetSha) {
    return failure("failed", "Target SHA changed; approval is stale.");
  }
  if (candidateSha !== task.approval.candidateSha) {
    return failure("failed", "Candidate SHA changed; approval is stale.");
  }

  try {
    input.store.transition(task.id, "integrating", "user-approved integration started");
  } catch (error) {
    return failure("failed", `Could not mark task integrating: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rollback = async (
    status: "integration_conflict" | "failed",
    reason: string,
    validationEvidence: ValidationEvidence[] = [],
  ): Promise<CandidateIntegrationResult> => {
    // `merge --abort` only cancels an in-progress merge. Validation may have
    // committed or written files on top, so restore the exact pre-merge
    // checkout. This is safe because preflight guaranteed a clean checkout
    // at `targetSha`: every later change came from the merge or validation.
    const restoreErrors: string[] = [];
    const abortError = await abortMerge(input.pi, input.cwd, input.signal);
    if (abortError) restoreErrors.push(`merge rollback failed: ${abortError}`);
    try {
      await git(input.pi, input.cwd, ["reset", "--hard", targetSha], input.signal);
    } catch (error) {
      restoreErrors.push(`reset failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await git(input.pi, input.cwd, ["clean", "-fd"], input.signal);
    } catch (error) {
      restoreErrors.push(`clean failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const finalReason = restoreErrors.length > 0 ? `${reason}; ${restoreErrors.join("; ")}` : reason;
    return recordFailure(input.store, task!, status, finalReason, validationEvidence);
  };

  try {
    const freshCandidateSha = await git(
      input.pi,
      input.cwd,
      ["rev-parse", "--verify", `refs/heads/${task.approval.candidateBranch}^{commit}`],
      input.signal,
    );
    if (freshCandidateSha !== task.approval.candidateSha) {
      return await rollback("failed", "Candidate SHA changed; approval is stale.");
    }
    const mergeResult = await input.pi.exec("git", ["merge", "--no-ff", "--no-commit", task.approval.candidateSha], {
      cwd: input.cwd,
      timeout: MERGE_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (mergeResult.killed || mergeResult.code !== 0) {
      const detail = mergeResult.stderr?.trim() || mergeResult.stdout?.trim() || `exit ${mergeResult.code}`;
      return await rollback("integration_conflict", `Candidate merge failed: ${detail}`);
    }

    const validation = await runValidationCommands(input.pi, input.cwd, task.validationCommands ?? []);
    if (!validation.passed) {
      return await rollback("failed", validation.error ?? "Integration validation failed.", validation.evidence);
    }

    const headAfterValidation = await git(input.pi, input.cwd, ["rev-parse", "HEAD^{commit}"], input.signal);
    if (headAfterValidation !== targetSha) {
      return await rollback("failed", "Integration checkout HEAD changed during validation; no integration commit was created.", validation.evidence);
    }
    const unstaged = await git(input.pi, input.cwd, ["diff", "--name-only"], input.signal);
    const untracked = await git(input.pi, input.cwd, ["ls-files", "--others", "--exclude-standard"], input.signal);
    const exactCandidateTree = await gitCheck(input.pi, input.cwd, ["diff", "--cached", "--quiet", candidateSha], input.signal);
    if (unstaged || untracked || !exactCandidateTree) {
      return await rollback("failed", "Integration validation changed the merge result; no integration commit was created.", validation.evidence);
    }

    const commit = await input.pi.exec(
      "git",
      ["commit", "--no-verify", "-m", `pi-agent: integrate ${task.id}`],
      {
        cwd: input.cwd,
        timeout: GIT_TIMEOUT_MS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (commit.killed || commit.code !== 0) {
      return await rollback("failed", `Integration commit failed: ${commit.stderr?.trim() || `exit ${commit.code}`}`, validation.evidence);
    }

    const integrationCommitSha = await git(input.pi, input.cwd, ["rev-parse", "HEAD^{commit}"], input.signal);
    try {
      input.store.transitionWithPatch(task.id, "integrated", "integration and validation succeeded", {
        integrationCommitSha,
        integrationValidationEvidence: validation.evidence,
      });
    } catch (error) {
      // The Git commit already exists; never attempt merge --abort here or
      // report a rollback that cannot undo a committed integration. Record
      // the commit under a dedicated status so it is never mistaken for a
      // failed integration without a commit.
      return recordCommittedWithoutState(input.store, task!, integrationCommitSha, validation.evidence, error);
    }
    return { status: "integrated", commitSha: integrationCommitSha, validationEvidence: validation.evidence };
  } catch (error) {
    return await rollback("failed", `Integration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
