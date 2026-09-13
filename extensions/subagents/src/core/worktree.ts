/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ValidationEvidence {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
}

export interface WorktreeValidationResult {
  passed: boolean;
  changedFiles: string[];
  evidence: ValidationEvidence[];
  error?: string;
}

export interface WorktreeCleanupOptions {
  /** Run scope and validation checks before any commit or branch creation. */
  validate?: (worktree: WorktreeInfo) => Promise<WorktreeValidationResult>;
}

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export type WorktreeCleanupStatus = "clean" | "candidate_ready" | "validation_failed" | "preservation_failed";

export interface WorktreeCleanupResult {
  /** The durable outcome of worktree finalization. */
  status: WorktreeCleanupStatus;
  /** Whether changes were found in the worktree or could not be ruled out. */
  hasChanges: boolean;
  /** Branch name if a candidate ref was created. */
  branch?: string;
  /** Worktree path if it was kept for recovery. */
  path?: string;
  /** Immutable candidate commit SHA after ref verification. */
  candidateSha?: string;
  /** Changed paths relative to the recorded base SHA. */
  changedFiles?: string[];
  /** Redacted evidence from sequential validation commands. */
  validationEvidence?: ValidationEvidence[];
  /** Recoverable failure detail when finalization could not complete. */
  error?: string;
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000);
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000);
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
  options: WorktreeCleanupOptions = {},
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    return { status: "clean", hasChanges: false };
  }

  let hasChanges = true;
  let branchName: string | undefined;
  let branchCreated = false;
  let validation: WorktreeValidationResult | undefined;

  try {
    // Check for uncommitted changes in the worktree. Until this succeeds, treat
    // the worktree as recoverable data rather than reporting it as clean.
    const initialStatus = await git(pi, worktree.path, ["status", "--porcelain"], 10000);
    if (!initialStatus) {
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);

      if (currentSha === worktree.baseSha) {
        hasChanges = false;
        // No changes — remove worktree. If removal fails, retain it and report
        // the failure rather than pretending the cleanup was complete.
        if (!await removeWorktree(pi, cwd, worktree.path)) {
          return preservationFailure(worktree, false, "Unable to remove the clean worktree.");
        }
        return { status: "clean", hasChanges: false, changedFiles: [] };
      }
    }

    // Agent Control validates before any preservation commit or candidate ref
    // is created. A failed check deliberately returns with the worktree intact.
    if (options.validate) {
      validation = await options.validate(worktree);
      if (!validation.passed) {
        return {
          status: "validation_failed",
          hasChanges: true,
          path: worktree.path,
          changedFiles: validation.changedFiles,
          validationEvidence: validation.evidence,
          error: validation.error ?? "Ship validation failed.",
        };
      }
    }

    // Validation commands may generate files, so inspect status again before
    // committing. This keeps those files inside the candidate and scope check.
    const postValidationStatus = await git(pi, worktree.path, ["status", "--porcelain"], 10000);
    if (postValidationStatus) {
      // Changes exist — stage, commit, and create a branch
      await git(pi, worktree.path, ["add", "-A"], 10000);
      // Truncate description for commit message (no shell sanitization needed — pi.exec uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      await git(pi, worktree.path, ["commit", "--no-verify", "-m", commitMsg], 10000);
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    branchName = worktree.branch;
    try {
      await git(pi, worktree.path, ["branch", branchName], 5000);
      branchCreated = true;
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(pi, worktree.path, ["branch", branchName], 5000);
      branchCreated = true;
    }

    // Verify the candidate ref before the worktree can be removed. This makes
    // the branch the recovery anchor even if cleanup is interrupted afterward.
    const worktreeSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);
    const branchSha = await git(pi, cwd, ["rev-parse", `refs/heads/${branchName}`], 5000);
    if (worktreeSha !== branchSha) {
      throw new Error(`Candidate branch ${branchName} does not point to worktree HEAD.`);
    }

    // Update branch name in worktree info for the caller
    worktree.branch = branchName;

    // Remove the worktree only after the candidate ref has been verified.
    // A failed removal leaves a valid candidate and a recoverable worktree.
    const removed = await removeWorktree(pi, cwd, worktree.path);
    return {
      status: "candidate_ready",
      hasChanges: true,
      branch: worktree.branch,
      candidateSha: branchSha,
      ...(validation?.changedFiles ? { changedFiles: validation.changedFiles } : {}),
      ...(validation?.evidence ? { validationEvidence: validation.evidence } : {}),
      ...(removed ? {} : { path: worktree.path }),
    };
  } catch (error) {
    return preservationFailure(
      worktree,
      hasChanges,
      error instanceof Error ? error.message : String(error),
      branchCreated ? branchName : undefined,
      validation,
    );
  }
}

function preservationFailure(
  worktree: WorktreeInfo,
  hasChanges: boolean,
  error: string,
  branch?: string,
  validation?: WorktreeValidationResult,
): WorktreeCleanupResult {
  return {
    status: "preservation_failed",
    hasChanges,
    ...(branch ? { branch } : {}),
    ...(validation?.changedFiles ? { changedFiles: validation.changedFiles } : {}),
    ...(validation?.evidence ? { validationEvidence: validation.evidence } : {}),
    ...(existsSync(worktree.path) ? { path: worktree.path } : {}),
    error,
  };
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<boolean> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
    return true;
  } catch {
    // git worktree remove failed — fall through to prune + fs fallback
  }
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
  // Windows EPERM guard: git prune may leave a locked .git file handle on win32.
  // Pure-fs retry loop — no shell, so a hostile worktreePath can never become
  // command injection (cmd.exe metachars like & % ^ are inert to rmSync).
  const { rmSync } = await import("node:fs");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === 4) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  return false;
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
}
