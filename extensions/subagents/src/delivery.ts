import { execFile as execFileCallback } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import type { SubagentWorktree } from "./worktree.ts";

const execFile = promisify(execFileCallback);
const COMMAND_TIMEOUT_MS = 120_000;
const SENSITIVE_PATH =
  /(^|[\\/])\.env(?:\.|$)|(?:secret|token|credential|password)/i;

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export interface ValidationResult {
  readonly changedFiles: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(https?:\/\/)[^@\s]+@/gi, "$1[redacted]@")
    .replace(
      /((?:token|secret|password|credential)[=:]\s*)[^\s]+/gi,
      "$1[redacted]",
    )
    .slice(0, 2_000);
}

async function runGit(args: readonly string[], cwd: string) {
  try {
    return await execFile("git", [...args], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
  } catch (error) {
    throw new DeliveryError(
      `git ${args.join(" ")} failed: ${safeError(error)}`,
    );
  }
}

function parseChangedFiles(status: string) {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (line.length > 3 ? line.slice(3).trim() : line));
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = (() => {
      try {
        return realpathSync.native(value);
      } catch {
        return path.resolve(value);
      }
    })();
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function normalizeBranch(value: string) {
  return value.replace(/^refs\/heads\//, "");
}

async function verifyWorktreeIdentity(worktree: SubagentWorktree) {
  const currentRoot = String(
    (await runGit(["rev-parse", "--show-toplevel"], worktree.path)).stdout,
  ).trim();
  const commonDirRaw = String(
    (await runGit(["rev-parse", "--git-common-dir"], worktree.path)).stdout,
  ).trim();
  const commonDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.resolve(worktree.path, commonDirRaw);
  const currentBranch = String(
    (await runGit(["branch", "--show-current"], worktree.path)).stdout,
  ).trim();
  const expectedCommonDir = path.join(worktree.repoRoot, ".git");
  if (
    !samePath(currentRoot, worktree.path) ||
    !samePath(commonDir, expectedCommonDir) ||
    normalizeBranch(currentBranch) !== normalizeBranch(worktree.branch)
  ) {
    throw new DeliveryError(
      "Refusing delivery because the recorded worktree path or branch identity changed.",
    );
  }
}

export async function validateWorktree(
  worktree: SubagentWorktree,
): Promise<ValidationResult> {
  await verifyWorktreeIdentity(worktree);
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    worktree.path,
  );
  const changedFiles = parseChangedFiles(String(status.stdout));
  const sensitive = changedFiles.find((file) => SENSITIVE_PATH.test(file));
  if (sensitive)
    throw new DeliveryError(
      `Refusing delivery because a sensitive-looking path changed: ${sensitive}`,
    );
  await runGit(["diff", "--check"], worktree.path);
  if (changedFiles.length === 0)
    throw new DeliveryError("No changes are available for delivery.");
  return { changedFiles, checks: ["git diff --check"] };
}

async function requireClean(worktree: SubagentWorktree) {
  await verifyWorktreeIdentity(worktree);
  const status = await runGit(["status", "--porcelain"], worktree.path);
  if (String(status.stdout).trim())
    throw new DeliveryError(
      "Worktree must be clean before this delivery operation.",
    );
}

function commitMessage(title: string) {
  const message = title
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  if (!message)
    throw new DeliveryError("A non-empty delivery title is required.");
  return message;
}

export async function commitWorktree(
  worktree: SubagentWorktree,
  title: string,
) {
  const validation = await validateWorktree(worktree);
  await runGit(["add", "-A"], worktree.path);
  await runGit(["diff", "--cached", "--check"], worktree.path);
  await runGit(["commit", "-m", commitMessage(title)], worktree.path);
  return validation;
}

export async function mergeWorktree(
  worktree: SubagentWorktree,
  targetCwd: string,
  title: string,
) {
  await verifyWorktreeIdentity(worktree);
  await requireClean(worktree);
  const targetStatus = await runGit(["status", "--porcelain"], targetCwd);
  if (String(targetStatus.stdout).trim())
    throw new DeliveryError("Coordinator checkout must be clean before merge.");
  await runGit(
    ["merge", "--no-ff", worktree.branch, "-m", commitMessage(title)],
    targetCwd,
  );
}

export async function pushWorktree(worktree: SubagentWorktree) {
  await verifyWorktreeIdentity(worktree);
  await requireClean(worktree);
  await runGit(["push", "origin", worktree.branch], worktree.path);
}

export async function createPullRequest(
  worktree: SubagentWorktree,
  title: string,
  body: string,
) {
  await verifyWorktreeIdentity(worktree);
  await requireClean(worktree);
  const base = String(
    (await runGit(["branch", "--show-current"], worktree.repoRoot)).stdout,
  ).trim();
  if (!base)
    throw new DeliveryError(
      "Cannot determine the coordinator branch for the pull request.",
    );
  try {
    const result = await execFile(
      "gh",
      [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        worktree.branch,
        "--title",
        commitMessage(title),
        "--body",
        body.slice(0, 16_000),
      ],
      {
        cwd: worktree.repoRoot,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    return String(result.stdout).trim();
  } catch (error) {
    throw new DeliveryError(`gh pr create failed: ${safeError(error)}`);
  }
}
