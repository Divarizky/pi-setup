import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import {
  createBranchName,
  createJobId,
  createSubagentWorktree,
  removeSubagentWorktree,
} from "../src/worktree.ts"

const execFile = promisify(execFileCallback)

async function git(cwd: string, args: string[]) {
  return execFile("git", args, { cwd, encoding: "utf8", windowsHide: true })
}

test("createBranchName follows conventional readable naming", () => {
  assert.equal(
    createBranchName("Recover missing session", { type: "fix", scope: "subagents" }),
    "fix/subagents/recover-missing-session",
  )
  assert.equal(createBranchName("Add docs"), "chore/subagents/add-docs")
})

test("createJobId produces a safe, unique subagent job id", () => {
  const first = createJobId("Fix auth/login bug")
  const second = createJobId("Fix auth/login bug")

  assert.notEqual(first, second)
  assert.match(first, /^fix-auth-login-bug-[a-z0-9-]+$/)
  assert.doesNotMatch(first, /[\\/]/)
})

test("retirement removes only a verified clean worktree", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-retire-"))
  const repoRoot = path.join(tempRoot, "repo")
  const workspaceRoot = path.join(tempRoot, "workspace")
  try {
    await execFile("git", ["init", repoRoot], { encoding: "utf8", windowsHide: true })
    await writeFile(path.join(repoRoot, "README.md"), "source\n", "utf8")
    await git(repoRoot, ["add", "README.md"])
    await git(repoRoot, ["-c", "user.name=Pi Test", "-c", "user.email=pi-test@example.invalid", "commit", "-m", "initial"])
    const worktree = await createSubagentWorktree({ sourceDir: repoRoot, workspaceRoot, jobId: "retire-test" })

    await removeSubagentWorktree(worktree)
    await assert.rejects(readFile(path.join(worktree.path, "README.md"), "utf8"))
    assert.equal((await git(repoRoot, ["status", "--porcelain"])).stdout.trim(), "")
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("explicit cascade deletion can remove a dirty worktree", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-delete-"))
  const repoRoot = path.join(tempRoot, "repo")
  const workspaceRoot = path.join(tempRoot, "workspace")
  try {
    await execFile("git", ["init", repoRoot], { encoding: "utf8", windowsHide: true })
    await writeFile(path.join(repoRoot, "README.md"), "source\n", "utf8")
    await git(repoRoot, ["add", "README.md"])
    await git(repoRoot, ["-c", "user.name=Pi Test", "-c", "user.email=pi-test@example.invalid", "commit", "-m", "initial"])
    const worktree = await createSubagentWorktree({ sourceDir: repoRoot, workspaceRoot, jobId: "delete-test" })
    await writeFile(path.join(worktree.path, "uncommitted.txt"), "discard me\n", "utf8")

    await removeSubagentWorktree(worktree, { force: true, deleteBranch: true })
    await assert.rejects(readFile(path.join(worktree.path, "uncommitted.txt"), "utf8"))
    assert.equal((await git(repoRoot, ["branch", "--list", worktree.branch])).stdout.trim(), "")
    // A retry after the checkout has already disappeared is idempotent.
    await removeSubagentWorktree(worktree, { force: true, deleteBranch: true })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("createSubagentWorktree isolates a subagent checkout from the source repo", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"))
  const repoRoot = path.join(tempRoot, "repo")
  const workspaceRoot = path.join(tempRoot, "workspace")

  try {
    await execFile("git", ["init", repoRoot], { encoding: "utf8", windowsHide: true })
    await writeFile(path.join(repoRoot, "README.md"), "source\n", "utf8")
    await git(repoRoot, ["add", "README.md"])
    await git(repoRoot, [
      "-c",
      "user.name=Pi Test",
      "-c",
      "user.email=pi-test@example.invalid",
      "commit",
      "-m",
      "initial",
    ])

    const worktree = await createSubagentWorktree({
      sourceDir: repoRoot,
      workspaceRoot,
      jobId: "job-isolation-test",
      branchName: "refactor/worktree/readable-naming",
    })

    await assert.rejects(
      createSubagentWorktree({
        sourceDir: repoRoot,
        workspaceRoot,
        jobId: "job-isolation-test-2",
        branchName: "refactor/worktree/readable-naming",
      }),
      /Branch already exists; refusing collision/,
    )

    assert.equal(
      (await readFile(path.join(worktree.path, "README.md"), "utf8")).replaceAll("\r\n", "\n"),
      "source\n",
    )
    assert.equal((await git(worktree.path, ["branch", "--show-current"])).stdout.trim(), worktree.branch)
    assert.equal(
      await realpath((await git(worktree.path, ["rev-parse", "--show-toplevel"])).stdout.trim()),
      await realpath(worktree.path),
    )

    await writeFile(path.join(worktree.path, "subagent.txt"), "subagent output\n", "utf8")
    await git(worktree.path, ["add", "subagent.txt"])

    const sourceStatus = (await git(repoRoot, ["status", "--porcelain"])).stdout.trim()
    assert.equal(sourceStatus, "")
    await assert.rejects(readFile(path.join(repoRoot, "subagent.txt"), "utf8"))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
