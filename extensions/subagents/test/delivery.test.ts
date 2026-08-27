import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  commitWorktree,
  mergeWorktree,
  validateWorktree,
} from "../src/delivery.ts";
import { createSubagentWorktree } from "../src/worktree.ts";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]) {
  return execFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-delivery-"));
  const repo = path.join(root, "repo");
  await execFile("git", ["init", repo], {
    encoding: "utf8",
    windowsHide: true,
  });
  await writeFile(path.join(repo, "README.md"), "source\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Pi Test",
    "-c",
    "user.email=pi-test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const worktree = await createSubagentWorktree({
    sourceDir: repo,
    workspaceRoot: path.join(root, "workspace"),
    jobId: "delivery-test",
  });
  return { root, repo, worktree };
}

test("delivery validates, commits, and merges an isolated worktree", async () => {
  const { root, repo, worktree } = await fixture();
  try {
    await writeFile(
      path.join(worktree.path, "change.txt"),
      "delivered\n",
      "utf8",
    );
    const validation = await validateWorktree(worktree);
    assert.deepEqual(validation.changedFiles, ["change.txt"]);
    await commitWorktree(worktree, "Add delivered change");
    assert.equal(
      (await git(worktree.path, ["status", "--porcelain"])).stdout.trim(),
      "",
    );
    await mergeWorktree(worktree, repo, "Merge delivered change");
    assert.equal(
      (await readFile(path.join(repo, "change.txt"), "utf8")).replace(
        /\r\n/g,
        "\n",
      ),
      "delivered\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery refuses sensitive-looking paths", async () => {
  const { root, worktree } = await fixture();
  try {
    await writeFile(
      path.join(worktree.path, ".env.local"),
      "SECRET=redacted\n",
      "utf8",
    );
    await assert.rejects(validateWorktree(worktree), /sensitive-looking path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
