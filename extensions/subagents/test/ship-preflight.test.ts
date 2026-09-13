import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { preflightShipTask, scopesOverlap } from "../src/task-control/ship-preflight.js";
import type { TaskRecord } from "../src/task-control/task-state.js";

function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const result = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout: result, stderr: "", code: 0, killed: false };
      } catch (error: any) {
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

function initGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agent-control-preflight-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# Test");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "pipe" });
  return repo;
}

function storeWith(...tasks: TaskRecord[]): { load: () => { tasks: Record<string, TaskRecord> } } {
  return { load: () => ({ tasks: Object.fromEntries(tasks.map(task => [task.id, task])) }) };
}

function activeTask(id: string, writeScope: string[]): TaskRecord {
  return {
    id,
    mode: "ship",
    policy: "ship",
    agentType: "build",
    objective: "Implement a change",
    repositoryPath: "/repo",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    writeScope,
  };
}

describe("Agent Control ship preflight", () => {
  let repo: string | undefined;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  it("accepts a clean committed branch without mutating Git", async () => {
    repo = initGitRepo();
    const result = await preflightShipTask({
      pi: mockPi(),
      cwd: repo,
      store: storeWith(),
      writeScope: ["src"],
      validationCommands: ["git status --short"],
      humanOverride: false,
      worktreeEnabled: true,
    });

    expect(result).toMatchObject({ ok: true, contract: { targetBranch: expect.any(String), writeScope: ["src"] } });
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
  });

  it("rejects a dirty checkout before task creation", async () => {
    repo = initGitRepo();
    writeFileSync(join(repo, "untracked.txt"), "dirty");

    const result = await preflightShipTask({
      pi: mockPi(),
      cwd: repo,
      store: storeWith(),
      validationCommands: ["git status --short"],
      humanOverride: false,
      worktreeEnabled: true,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining("main checkout is dirty") }));
  });

  it("blocks overlapping active ship scopes without a human override", async () => {
    repo = initGitRepo();
    const result = await preflightShipTask({
      pi: mockPi(),
      cwd: repo,
      store: storeWith(activeTask("task-1", ["src/api"])),
      writeScope: ["src/api/routes"],
      validationCommands: ["git status --short"],
      humanOverride: false,
      worktreeEnabled: true,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining("explicit human override") }));
  });

  it("treats clearly separate scope roots as non-overlapping", () => {
    expect(scopesOverlap("src/api", "src/ui")).toBe(false);
    expect(scopesOverlap("src", "src/api")).toBe(true);
  });

  it("treats a mid-segment wildcard as overlapping sibling names", () => {
    expect(scopesOverlap("src/api*", "src/api2")).toBe(true);
    expect(scopesOverlap("src/api*", "src/ui")).toBe(false);
  });

  it("blocks a held candidate in the same scope", async () => {
    repo = initGitRepo();
    const result = await preflightShipTask({
      pi: mockPi(),
      cwd: repo,
      store: storeWith({ ...activeTask("task-1", ["src/api"]), status: "candidate_ready" }),
      writeScope: ["src/api"],
      validationCommands: ["git status --short"],
      humanOverride: false,
      worktreeEnabled: true,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining("explicit human override") }));
  });
});
