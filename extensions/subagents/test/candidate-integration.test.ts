import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { integrateApprovedCandidate } from "../src/task-control/candidate-integration.js";
import { captureCandidateApproval } from "../src/task-control/task-approval.js";
import type { TaskRecord } from "../src/task-control/task-state.js";
import { TaskStore } from "../src/task-control/task-store.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

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

function initRepo(): { repo: string; targetBranch: string; baseSha: string; store: TaskStore } {
  const repo = mkdtempSync(join(tmpdir(), "agent-control-integration-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return {
    repo,
    targetBranch: git(repo, ["branch", "--show-current"]),
    baseSha: git(repo, ["rev-parse", "HEAD"]),
    store: new TaskStore(join(repo, ".git")),
  };
}

function createCandidate(repo: string, baseSha: string): { branch: string; sha: string } {
  const branch = "agent/task-1";
  git(repo, ["checkout", "-b", branch, baseSha]);
  writeFileSync(join(repo, "candidate.txt"), "candidate\n");
  git(repo, ["add", "candidate.txt"]);
  git(repo, ["commit", "-m", "candidate"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-"]);
  return { branch, sha };
}

function candidateTask(
  repo: string,
  targetBranch: string,
  baseSha: string,
  candidate: { branch: string; sha: string },
  commands: string[],
): TaskRecord {
  return {
    id: "task-1",
    mode: "ship",
    policy: "ship",
    agentType: "build",
    objective: "Integrate candidate",
    repositoryPath: repo,
    status: "candidate_ready",
    createdAt: 1,
    updatedAt: 2,
    baseSha,
    targetBranch,
    candidateBranch: candidate.branch,
    candidateSha: candidate.sha,
    validationCommands: commands,
  };
}

describe("approved candidate integration", () => {
  let repo: string | undefined;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  it("merges the exact approved candidate, validates, and records integrated", async () => {
    const setup = initRepo();
    repo = setup.repo;
    const candidate = createCandidate(repo, setup.baseSha);
    const task = candidateTask(repo, setup.targetBranch, setup.baseSha, candidate, ["node -e \"process.exit(0)\""]);
    setup.store.createTask(task);
    setup.store.updateTask(task.id, { approval: captureCandidateApproval(task, "approved", 3) });

    const result = await integrateApprovedCandidate({ pi: mockPi(), cwd: repo, store: setup.store, taskId: task.id });

    expect(result.status).toBe("integrated");
    expect(existsSync(join(repo, "candidate.txt"))).toBe(true);
    expect(git(repo, ["branch", "--list", candidate.branch])).toContain(candidate.branch);
    expect(setup.store.load().tasks[task.id]).toMatchObject({ status: "integrated", integrationCommitSha: git(repo, ["rev-parse", "HEAD"]) });
    expect(git(repo, ["rev-parse", "HEAD^2"])).toBe(candidate.sha);
  }, 20_000);

  it("rejects a branch beginning with a dash before Git mutation", async () => {
    const setup = initRepo();
    repo = setup.repo;
    const candidate = createCandidate(repo, setup.baseSha);
    const task = {
      ...candidateTask(repo, setup.targetBranch, setup.baseSha, candidate, ["node -e \"process.exit(0)\""]),
      candidateBranch: "-evil",
    };
    setup.store.createTask(task);
    setup.store.updateTask(task.id, {
      approval: { ...captureCandidateApproval({ ...task, candidateBranch: candidate.branch }, "approved", 3), candidateBranch: "-evil" },
    });
    const before = git(repo, ["rev-parse", "HEAD"]);

    const result = await integrateApprovedCandidate({ pi: mockPi(), cwd: repo, store: setup.store, taskId: task.id });

    expect(result).toMatchObject({ status: "failed", error: "Approved candidate branch name is invalid." });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(setup.store.load().tasks[task.id].status).toBe("candidate_ready");
  }, 20_000);

  it("rejects validation that commits during integration", async () => {
    const setup = initRepo();
    repo = setup.repo;
    const candidate = createCandidate(repo, setup.baseSha);
    const task = candidateTask(repo, setup.targetBranch, setup.baseSha, candidate, ["git commit --allow-empty -m validation-side-effect"]);
    setup.store.createTask(task);
    setup.store.updateTask(task.id, { approval: captureCandidateApproval(task, "approved", 3) });
    const before = git(repo, ["rev-parse", "HEAD"]);

    const result = await integrateApprovedCandidate({ pi: mockPi(), cwd: repo, store: setup.store, taskId: task.id });

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("HEAD changed") });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(setup.store.load().tasks[task.id].status).toBe("failed");
  }, 20_000);

  it("rejects a stale candidate ref before changing the target checkout", async () => {
    const setup = initRepo();
    repo = setup.repo;
    const candidate = createCandidate(repo, setup.baseSha);
    const task = candidateTask(repo, setup.targetBranch, setup.baseSha, candidate, ["node -e \"process.exit(0)\""]);
    setup.store.createTask(task);
    setup.store.updateTask(task.id, { approval: captureCandidateApproval(task, "approved", 3) });
    git(repo, ["checkout", candidate.branch]);
    writeFileSync(join(repo, "candidate.txt"), "advanced\n");
    git(repo, ["add", "candidate.txt"]);
    git(repo, ["commit", "-m", "move candidate"]);
    git(repo, ["checkout", setup.targetBranch]);
    const before = git(repo, ["rev-parse", "HEAD"]);

    const result = await integrateApprovedCandidate({ pi: mockPi(), cwd: repo, store: setup.store, taskId: task.id });

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("Candidate SHA changed") });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(setup.store.load().tasks[task.id].status).toBe("candidate_ready");
  }, 20_000);

  it("rejects a persisted task from another repository before Git mutation", async () => {
    const setup = initRepo();
    repo = setup.repo;
    const candidate = createCandidate(repo, setup.baseSha);
    const task = {
      ...candidateTask(repo, setup.targetBranch, setup.baseSha, candidate, ["node -e \"process.exit(0)\""]),
      repositoryPath: join(repo, "elsewhere"),
    };
    setup.store.createTask(task);
    setup.store.updateTask(task.id, { approval: captureCandidateApproval({ ...task, repositoryPath: repo }, "approved", 3) });
    const before = git(repo, ["rev-parse", "HEAD"]);

    const result = await integrateApprovedCandidate({ pi: mockPi(), cwd: repo, store: setup.store, taskId: task.id });

    expect(result).toMatchObject({ status: "failed", error: "Integration repository does not match the task repository." });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(setup.store.load().tasks[task.id].status).toBe("candidate_ready");
  }, 20_000);

  it("aborts a failed integration validation and retains the candidate branch", async () => {
    const setup = initRepo();
    repo = setup.repo;
    const candidate = createCandidate(repo, setup.baseSha);
    const task = candidateTask(repo, setup.targetBranch, setup.baseSha, candidate, ["node -e \"process.exit(7)\""]);
    setup.store.createTask(task);
    setup.store.updateTask(task.id, { approval: captureCandidateApproval(task, "approved", 3) });
    const before = git(repo, ["rev-parse", "HEAD"]);

    const result = await integrateApprovedCandidate({ pi: mockPi(), cwd: repo, store: setup.store, taskId: task.id });

    expect(result).toMatchObject({ status: "failed", validationEvidence: [{ exitCode: 7 }] });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(repo, ["branch", "--list", candidate.branch])).toContain(candidate.branch);
    expect(setup.store.load().tasks[task.id].status).toBe("failed");
  }, 20_000);
});
