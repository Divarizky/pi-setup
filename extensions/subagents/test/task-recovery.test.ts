import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree, pruneWorktrees } from "../src/core/worktree.js";
import { reconcileTaskStore } from "../src/task-control/task-recovery.js";
import type { TaskRecord } from "../src/task-control/task-state.js";
import { TaskStore } from "../src/task-control/task-store.js";

function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (error: any) {
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

function initGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agent-control-recovery-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# Test");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "pipe" });
  return repo;
}

function task(repo: string, id: string, status: TaskRecord["status"] = "running"): TaskRecord {
  return {
    id,
    mode: "ship",
    policy: "ship",
    agentType: "build",
    objective: "Recover delivery",
    repositoryPath: repo,
    status,
    createdAt: 1,
    updatedAt: 1,
    baseSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    targetBranch: execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim(),
    writeScope: ["**"],
    validationCommands: ["git status --short"],
  };
}

describe("Agent Control task recovery", () => {
  let repo: string | undefined;
  const pi = mockPi();

  afterEach(async () => {
    if (repo) {
      try { await pruneWorktrees(pi, repo); } catch { /* ignore */ }
      rmSync(repo, { recursive: true, force: true });
    }
    repo = undefined;
  });

  it("marks an in-flight task interrupted and is idempotent", async () => {
    repo = initGitRepo();
    const store = new TaskStore(join(repo, ".git"));
    store.createTask(task(repo, "task-running"));

    const first = await reconcileTaskStore(pi, repo, store);
    expect(store.load().tasks["task-running"].status).toBe("interrupted");
    expect(first.changedTaskIds).toEqual(["task-running"]);

    const second = await reconcileTaskStore(pi, repo, store);
    expect(second.changedTaskIds).toEqual([]);
    expect(store.load().tasks["task-running"].status).toBe("interrupted");
  });

  it("keeps a valid candidate SHA and evidence after restart", async () => {
    repo = initGitRepo();
    writeFileSync(join(repo, "candidate.txt"), "candidate");
    execFileSync("git", ["add", "candidate.txt"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "candidate"], { cwd: repo, stdio: "pipe" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["branch", "pi-agent-recovered", sha], { cwd: repo, stdio: "pipe" });

    const store = new TaskStore(join(repo, ".git"));
    const candidate = task(repo, "task-candidate", "candidate_ready");
    candidate.candidateBranch = "pi-agent-recovered";
    candidate.candidateSha = sha;
    candidate.changedFiles = ["candidate.txt"];
    candidate.validationEvidence = [{
      command: "git status --short",
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      startedAt: 2,
      finishedAt: 3,
    }];
    store.createTask(candidate);

    const report = await reconcileTaskStore(pi, repo, store);
    expect(report.changedTaskIds).toEqual([]);
    expect(store.load().tasks["task-candidate"]).toMatchObject({
      status: "candidate_ready",
      candidateSha: sha,
      changedFiles: ["candidate.txt"],
      validationEvidence: [{ command: "git status --short" }],
    });
  });

  it("marks an orphan worktree with changes recovery_required without pruning it", async () => {
    repo = initGitRepo();
    const wt = (await createWorktree(pi, repo, "orphan-task"))!;
    writeFileSync(join(wt.path, "orphan.txt"), "recover me");

    const store = new TaskStore(join(repo, ".git"));
    const orphan = task(repo, "task-orphan");
    orphan.worktreePath = wt.path;
    store.createTask(orphan);

    const report = await reconcileTaskStore(pi, repo, store);
    expect(report.recoveryRequiredTaskIds).toEqual(["task-orphan"]);
    expect(store.load().tasks["task-orphan"].status).toBe("recovery_required");
    expect(store.load().tasks["task-orphan"].worktreePath).toBe(wt.path);
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).toContain("pi-agent-orphan-task-");
  });
});
