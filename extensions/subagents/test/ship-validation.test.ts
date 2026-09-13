import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/core/worktree.js";
import { validateShipWorktree } from "../src/task-control/delivery-validation.js";

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
  const repo = mkdtempSync(join(tmpdir(), "agent-control-validation-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# Test");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "pipe" });
  return repo;
}

describe("Agent Control delivery validation", () => {
  let repo: string | undefined;

  afterEach(async () => {
    if (repo) {
      try { await pruneWorktrees(mockPi(), repo); } catch { /* ignore */ }
      rmSync(repo, { recursive: true, force: true });
    }
    repo = undefined;
  });

  it("runs validation commands sequentially and redacts captured output", async () => {
    repo = initGitRepo();
    const wt = (await createWorktree(mockPi(), repo, "validation-pass"))!;
    writeFileSync(join(wt.path, "src.txt"), "change");

    const result = await validateShipWorktree(mockPi(), wt, ["src.txt"], [
      "node -e \"console.log('token=super-secret')\"",
      "git status --short",
    ]);

    expect(result.passed).toBe(true);
    expect(result.changedFiles).toEqual(["src.txt"]);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0].stdout).toContain("[REDACTED]");
    expect(result.evidence[0].stdout).not.toContain("super-secret");
  });

  it("redacts bearer headers, provider tokens, JWTs, and private keys", async () => {
    repo = initGitRepo();
    const wt = (await createWorktree(mockPi(), repo, "validation-redaction"))!;
    writeFileSync(join(wt.path, "src.txt"), "change");

    const result = await validateShipWorktree(mockPi(), wt, ["src.txt"], [
      "node -e \"console.log('Authorization: Bearer abcdefgh12345678')\"",
      "node -e \"console.log('sk-proj-abcdefgh12345678')\"",
    ]);

    expect(result.passed).toBe(true);
    expect(result.evidence[0].stdout).toContain("Bearer [REDACTED]");
    expect(result.evidence[0].stdout).not.toContain("abcdefgh12345678");
    expect(result.evidence[1].stdout).toContain("[REDACTED]");
    expect(result.evidence[1].stdout).not.toContain("sk-proj-");
  });

  it("fails fast and retains the worktree when validation fails", async () => {
    repo = initGitRepo();
    const wt = (await createWorktree(mockPi(), repo, "validation-fail"))!;
    writeFileSync(join(wt.path, "src.txt"), "change");

    const result = await cleanupWorktree(mockPi(), repo, wt, "validation failure", {
      validate: current => validateShipWorktree(mockPi(), current, ["src.txt"], [
        "node -e \"process.exit(7)\"",
        "node -e \"process.exit(0)\"",
      ]),
    });

    expect(result.status).toBe("validation_failed");
    expect(result.validationEvidence).toHaveLength(1);
    expect(result.validationEvidence?.[0].exitCode).toBe(7);
    expect(result.branch).toBeUndefined();
    expect(result.path).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("rejects out-of-scope changes without creating a candidate branch", async () => {
    repo = initGitRepo();
    const wt = (await createWorktree(mockPi(), repo, "scope-fail"))!;
    writeFileSync(join(wt.path, "outside.txt"), "change");

    const result = await cleanupWorktree(mockPi(), repo, wt, "scope failure", {
      validate: current => validateShipWorktree(mockPi(), current, ["src/"], ["node -e \"process.exit(0)\""]),
    });

    expect(result.status).toBe("validation_failed");
    expect(result.error).toContain("outside declared write scope");
    expect(result.branch).toBeUndefined();
    expect(existsSync(wt.path)).toBe(true);
  });

  it("persists candidate metadata only after all validation succeeds", async () => {
    repo = initGitRepo();
    const wt = (await createWorktree(mockPi(), repo, "candidate-pass"))!;
    writeFileSync(join(wt.path, "src.txt"), "change");

    const result = await cleanupWorktree(mockPi(), repo, wt, "candidate success", {
      validate: current => validateShipWorktree(mockPi(), current, ["src.txt"], ["node -e \"process.exit(0)\""]),
    });

    expect(result).toMatchObject({ status: "candidate_ready", hasChanges: true, changedFiles: ["src.txt"] });
    expect(result.candidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.validationEvidence).toHaveLength(1);
    expect(existsSync(wt.path)).toBe(false);
    expect(execFileSync("git", ["rev-parse", result.branch!], { cwd: repo, encoding: "utf8" }).trim()).toBe(result.candidateSha);
  }, 20_000);
});
