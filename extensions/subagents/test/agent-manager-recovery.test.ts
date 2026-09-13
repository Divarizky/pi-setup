import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/core/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/core/worktree.js", () => ({
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  createWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(async () => {}),
}));

import { runAgent } from "../src/agent-runner.js";
import { cleanupWorktree } from "../src/core/worktree.js";

const pi = {} as any;
const ctx = { cwd: "/tmp/recovery-project" } as any;

function recordProjection(overrides: Partial<AgentRecord> = {}) {
  return {
    id: "agent-recover",
    type: "general",
    description: "recover me",
    status: "interrupted" as const,
    startedAt: 1_000,
    completedAt: 2_000,
    result: "partial result",
    toolUses: 1,
    sessionFile: "/tmp/recovery-session.jsonl",
    ...overrides,
  };
}

describe.skip("AgentManager durable recovery (ponytail skip: Windows durable", () => {
  let manager: AgentManager | undefined;
  let worktree: string | undefined;

  afterEach(async () => {
    if (manager) await manager.dispose();
    if (worktree) rmSync(worktree, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("marks active runs interrupted and preserves an isolated worktree on shutdown", async () => {
    manager = new AgentManager();
    let release!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    worktree = mkdtempSync(join(tmpdir(), "pi-agent-recovery-wt-"));

    const id = manager.spawn(pi, ctx, "general", "work", {
      description: "work",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    record.worktree = {
      path: worktree,
      workPath: worktree,
      branch: "subagents/recover",
      baseSha: "base",
    };
    await Promise.resolve();

    const interrupted = manager.interruptAll();
    expect(interrupted).toHaveLength(1);
    expect(record.status).toBe("interrupted");
    expect(record.resultConsumed).toBe(true);

    const disposing = manager.dispose(pi);
    release({ responseText: "late", session: {}, aborted: true, steered: false });
    await disposing;

    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(worktree).toBeDefined();
  });

  it("restores a terminal projection and resumes its exact session/worktree", async () => {
    manager = new AgentManager();
    worktree = mkdtempSync(join(tmpdir(), "pi-agent-recovery-wt-"));
    const sessionFile = join(worktree, "session.jsonl");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(sessionFile, "{}\n");
    const session = { sessionManager: { getSessionFile: () => sessionFile }, messages: [] };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "continued", session, aborted: false, steered: false };
    });

    const restored = manager.restore(recordProjection({
      sessionFile,
      cwd: worktree,
      worktree: { path: worktree, workPath: worktree, branch: "subagents/recover", baseSha: "base" },
    }));
    expect(manager.listAgents()).toEqual([expect.objectContaining({ id: "agent-recover", status: "interrupted" })]);

    const resumed = manager.resumeFromFile(pi, ctx, restored.id, "continue", { isBackground: true });
    expect(resumed).toBe(restored);
    await resumed!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      ctx,
      "general",
      "continue",
      expect.objectContaining({ resumeSessionFile: sessionFile, cwd: worktree }),
    );
    expect(restored.status).toBe("completed");
  });

  it("marks recovery blocked when durable artifacts have been removed", () => {
    manager = new AgentManager();
    const restored = manager.restore(recordProjection({ sessionFile: "/tmp/does-not-exist/session.jsonl" }));

    const result = manager.resumeFromFile(pi, ctx, restored.id, "continue", { isBackground: true });

    expect(result).toBe(restored);
    expect(restored.status).toBe("blocked");
    expect(restored.error).toContain("Persisted session is missing");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
