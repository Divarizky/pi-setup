import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canTransitionTask, type TaskRecord, type TaskStatus } from "./task-state.js";
import { type TaskSnapshot, type TaskStore } from "./task-store.js";

interface GitWorktree {
  path: string;
  head: string;
  branch?: string;
}

export interface TaskRecoveryReport {
  changedTaskIds: string[];
  interruptedTaskIds: string[];
  recoveredCandidateTaskIds: string[];
  recoveryRequiredTaskIds: string[];
  errors: string[];
}

const IN_FLIGHT: ReadonlySet<TaskStatus> = new Set(["preparing", "running", "integrating"]);
const TERMINAL_WITHOUT_RECOVERY: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "completed_no_changes",
  "rejected",
  "integrated",
]);

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[], timeout = 10_000): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout ?? "";
}

function parseWorktrees(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length), head: "" };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    }
  }
  if (current) worktrees.push(current);
  return worktrees.filter(worktree => worktree.path.length > 0);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function safePersistedWorktreePath(value: string): boolean {
  if (!isAbsolute(value)) return false;
  const path = resolve(value);
  const root = resolve(tmpdir());
  return path !== root && path.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`);
}

function validBranchName(branch: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes("..") && !branch.startsWith("/");
}

async function listWorktrees(pi: ExtensionAPI, cwd: string): Promise<GitWorktree[]> {
  return parseWorktrees(await gitOutput(pi, cwd, ["worktree", "list", "--porcelain"]));
}

async function candidateSha(pi: ExtensionAPI, cwd: string, task: TaskRecord): Promise<string | undefined> {
  if (!task.candidateBranch || !task.candidateSha || !validBranchName(task.candidateBranch)) return undefined;
  if (!/^[0-9a-f]{40,64}$/i.test(task.candidateSha)) return undefined;
  try {
    const resolved = await gitOutput(
      pi,
      cwd,
      ["rev-parse", "--verify", `refs/heads/${task.candidateBranch}^{commit}`],
      5_000,
    );
    return resolved.trim().toLowerCase() === task.candidateSha.toLowerCase() ? task.candidateSha : undefined;
  } catch {
    return undefined;
  }
}

interface RecoveryWorktree {
  path: string;
  registered: boolean;
}

function findTaskWorktree(task: TaskRecord, worktrees: readonly GitWorktree[]): RecoveryWorktree | undefined {
  if (!task.worktreePath || !safePersistedWorktreePath(task.worktreePath)) return undefined;
  const listed = worktrees.find(worktree => samePath(worktree.path, task.worktreePath!));
  if (listed) return { path: listed.path, registered: true };
  // A previous `git worktree prune` may have removed only the registration.
  // Retain an existing, safe temp path as recovery-required rather than
  // executing arbitrary persisted paths or deleting anything automatically.
  if (existsSync(task.worktreePath)) return { path: resolve(task.worktreePath), registered: false };
  return undefined;
}

async function worktreeHasChanges(
  pi: ExtensionAPI,
  worktree: RecoveryWorktree,
  task: TaskRecord,
): Promise<boolean> {
  try {
    const status = await gitOutput(pi, worktree.path, ["status", "--porcelain", "--untracked-files=all"], 10_000);
    if (status.trim()) return true;
    const head = await gitOutput(pi, worktree.path, ["rev-parse", "HEAD"], 5_000);
    return Boolean(task.baseSha && head.trim() !== task.baseSha);
  } catch {
    // A path that exists but cannot be inspected is not safe to prune or call
    // clean. Keep it recoverable and let the operator repair it.
    return true;
  }
}

function transitionIfNeeded(
  store: TaskStore,
  task: TaskRecord,
  nextStatus: TaskStatus,
  reason: string,
  report: TaskRecoveryReport,
): boolean {
  if (task.status === nextStatus) return true;
  if (!canTransitionTask(task.status, nextStatus)) return false;
  try {
    store.transition(task.id, nextStatus, reason);
    report.changedTaskIds.push(task.id);
    if (nextStatus === "interrupted") report.interruptedTaskIds.push(task.id);
    if (nextStatus === "candidate_ready") report.recoveredCandidateTaskIds.push(task.id);
    if (nextStatus === "recovery_required") report.recoveryRequiredTaskIds.push(task.id);
    return true;
  } catch (error) {
    report.errors.push(`Task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Reconcile durable task state against repository-local Git refs and worktrees.
 * This function never starts an agent, removes a worktree, or runs `git prune`.
 */
export async function reconcileTaskStore(
  pi: ExtensionAPI,
  cwd: string,
  store: TaskStore,
): Promise<TaskRecoveryReport> {
  const report: TaskRecoveryReport = {
    changedTaskIds: [],
    interruptedTaskIds: [],
    recoveredCandidateTaskIds: [],
    recoveryRequiredTaskIds: [],
    errors: [],
  };

  let snapshot: TaskSnapshot;
  let worktrees: GitWorktree[];
  try {
    snapshot = store.load();
    worktrees = await listWorktrees(pi, cwd);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }

  for (const task of Object.values(snapshot.tasks)) {
    const validCandidate = await candidateSha(pi, cwd, task);
    const worktree = findTaskWorktree(task, worktrees);
    const hasChanges = worktree ? await worktreeHasChanges(pi, worktree, task) : false;

    // Candidate refs are the strongest recovery anchor. A validation_failed
    // task is intentionally not promoted: its branch must not become
    // approvable merely because it survived a restart.
    if (validCandidate && task.status !== "validation_failed") {
      transitionIfNeeded(store, task, "candidate_ready", "candidate ref verified during startup recovery", report);
      continue;
    }

    const candidateWasExpected = task.status === "candidate_ready";
    if (candidateWasExpected && !validCandidate) {
      transitionIfNeeded(store, task, "recovery_required", "candidate ref is missing or no longer points to the recorded SHA", report);
      continue;
    }

    if (worktree && hasChanges) {
      transitionIfNeeded(store, task, "recovery_required", "orphan worktree contains changes and has no verified candidate ref", report);
      continue;
    }

    if (IN_FLIGHT.has(task.status)) {
      transitionIfNeeded(store, task, "interrupted", "owner process was not present during startup recovery", report);
      continue;
    }

    if (task.status === "validation_failed" && worktree && !hasChanges) {
      // Keep the validation outcome; there is no artifact left that needs a
      // recovery marker and the failed status is already terminal for MVP.
      continue;
    }

    if (TERMINAL_WITHOUT_RECOVERY.has(task.status)) continue;
  }

  return report;
}
