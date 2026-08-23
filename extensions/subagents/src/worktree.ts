import { execFile as execFileCallback } from "node:child_process"
import { randomBytes, createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, realpath } from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const GIT_TIMEOUT_MS = 30_000

export const CONVENTIONAL_BRANCH_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "build",
  "ci",
  "perf",
  "style",
  "revert",
] as const

export type ConventionalBranchType = (typeof CONVENTIONAL_BRANCH_TYPES)[number]

export interface SubagentWorktree {
  readonly jobId: string
  readonly repoRoot: string
  readonly path: string
  readonly branch: string
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorktreeError"
  }
}

function safeSegment(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
  return normalized || fallback
}

export function createJobId(title: string) {
  const label = safeSegment(title, "job")
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
  return `${label}-${suffix}`
}

function projectKey(repoRoot: string) {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)
}

export function createBranchName(
  title: string,
  options: {
    readonly type?: ConventionalBranchType
    readonly scope?: string
  } = {},
) {
  const type = options.type ?? "chore"
  const scope = safeSegment(options.scope ?? "subagents", "subagents").slice(0, 32)
  const slug = safeSegment(title, "subagent")
  return `${type}/${scope}/${slug}`
}

async function runGit(args: readonly string[], cwd: string) {
  try {
    const result = await execFile("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      encoding: "utf8",
    })
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorktreeError(`git ${args.join(" ")} failed: ${detail}`)
  }
}

export async function resolveRepoRoot(sourceDir: string) {
  const sourcePath = await realpath(sourceDir).catch(() => {
    throw new WorktreeError(`Source directory is not resolvable: ${sourceDir}`)
  })
  const result = await runGit(["rev-parse", "--show-toplevel"], sourcePath)
  const root = result.stdout.trim()
  if (!root) throw new WorktreeError(`Not a Git repository: ${sourcePath}`)
  return realpath(root).catch(() => {
    throw new WorktreeError(`Git repository root is not resolvable: ${root}`)
  })
}

/**
 * Create a dedicated branch/worktree for one subagent job.
 *
 * The worktree lives in the agent's workspace, outside the source checkout.
 * It is intentionally not removed here: uncommitted subagent output must
 * remain recoverable until the agent explicitly disposes it.
 */
export async function assertWorktreeClean(worktreePath: string): Promise<void> {
  const result = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath)
  if (result.stdout.trim()) {
    throw new WorktreeError(`Refusing read-only subagent operation on dirty worktree: ${worktreePath}`)
  }
}

export async function deleteSubagentBranch(repoRoot: string, branch: string): Promise<void> {
  const refs = (await runGit([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ], repoRoot)).stdout
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter(Boolean)
  if (refs.includes(branch)) await runGit(["branch", "-D", branch], repoRoot)
}

export async function removeSubagentWorktree(
  worktree: SubagentWorktree,
  options: { readonly force?: boolean; readonly deleteBranch?: boolean } = {},
): Promise<void> {
  const repoRoot = await realpath(worktree.repoRoot).catch(() => {
    throw new WorktreeError(`Repository root is not resolvable: ${worktree.repoRoot}`)
  })
  const normalizePath = (value: string) => {
    const resolved = path.resolve(value)
    const canonical = (() => {
      try { return realpathSync.native(resolved) } catch { return resolved }
    })()
    return process.platform === "win32" ? canonical.toLowerCase() : canonical
  }
  const targetPath = await realpath(worktree.path).catch(() => undefined)
  if (!targetPath) {
    if (!options.deleteBranch) throw new WorktreeError(`Refusing to retire unverified worktree: ${normalizePath(worktree.path)}`)
    // The checkout may already have been removed by Orca or a previous retry.
    // The recorded branch is still cleaned up, but only from the recorded repo.
    await deleteSubagentBranch(repoRoot, worktree.branch)
    return
  }
  const target = normalizePath(targetPath)

  // Verify the checkout from inside the recorded path and compare its Git
  // common directory with the source repository. Git may spell the same
  // Windows path differently (long path vs 8.3 alias), so raw path text is unsafe.
  let currentRoot: string
  let currentBranch: string
  let currentCommonDir: string
  let repoCommonDir: string
  try {
    currentRoot = (await runGit(["rev-parse", "--show-toplevel"], targetPath)).stdout.trim()
    currentBranch = (await runGit(["branch", "--show-current"], targetPath)).stdout.trim()
    const currentCommon = (await runGit(["rev-parse", "--git-common-dir"], targetPath)).stdout.trim()
    const repoCommon = (await runGit(["rev-parse", "--git-common-dir"], repoRoot)).stdout.trim()
    currentCommonDir = path.isAbsolute(currentCommon) ? currentCommon : path.resolve(targetPath, currentCommon)
    repoCommonDir = path.isAbsolute(repoCommon) ? repoCommon : path.resolve(repoRoot, repoCommon)
  } catch {
    throw new WorktreeError(`Refusing to retire unverified worktree: ${target}`)
  }
  if (
    normalizePath(currentRoot) !== target
    || normalizePath(currentCommonDir) !== normalizePath(repoCommonDir)
    || currentBranch !== worktree.branch
  ) {
    throw new WorktreeError(`Refusing to retire unverified worktree: ${target}`)
  }

  const args = ["worktree", "remove"]
  if (options.force) args.push("--force")
  await runGit([...args, targetPath], repoRoot)
  if (options.deleteBranch) await deleteSubagentBranch(repoRoot, worktree.branch)
}

export async function assertBranchAvailable(repoRoot: string, branch: string): Promise<void> {
  const refs = (await runGit([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ], repoRoot)).stdout
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter(Boolean)
  if (refs.some((ref) => ref === branch || ref.endsWith(`/${branch}`))) {
    throw new WorktreeError(`Branch already exists; refusing collision: ${branch}`)
  }
}

export async function createSubagentWorktree(options: {
  readonly sourceDir: string
  readonly workspaceRoot: string
  readonly jobId: string
  readonly branchName?: string
}): Promise<SubagentWorktree> {
  const repoRoot = await resolveRepoRoot(options.sourceDir)
  const jobId = safeSegment(options.jobId, createJobId("job"))
  const branch = options.branchName ?? `subagent/${jobId}`
  await assertBranchAvailable(repoRoot, branch)
  const projectRoot = path.join(
    path.resolve(options.workspaceRoot),
    "worktrees",
    projectKey(repoRoot),
  )
  const worktreeDirectory = safeSegment(branch.replaceAll("/", "-"), jobId)
  const worktreePath = path.join(projectRoot, worktreeDirectory)

  await mkdir(projectRoot, { recursive: true })
  await runGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], repoRoot)

  return { jobId, repoRoot, path: worktreePath, branch }
}
