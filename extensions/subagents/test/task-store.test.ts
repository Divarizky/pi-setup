import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCandidateApproval } from "../src/task-control/task-approval.js";
import type { TaskRecord } from "../src/task-control/task-state.js";
import { TaskStore } from "../src/task-control/task-store.js";

function task(): TaskRecord {
  return {
    id: "task-1",
    mode: "scout",
    policy: "scout",
    agentType: "explore",
    objective: "Inspect the repository",
    repositoryPath: "/repo",
    status: "preparing",
    createdAt: 100,
    updatedAt: 100,
  };
}

describe("Agent Control durable task store", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a repository-local snapshot atomically and records creation", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-control-store-"));
    const store = new TaskStore(dir, () => 200);

    store.createTask(task());

    expect(store.load()).toEqual({ version: 1, tasks: { "task-1": task() } });
    expect(store.readEvents()).toEqual([
      {
        taskId: "task-1",
        previousStatus: undefined,
        nextStatus: "preparing",
        reason: "task created",
        timestamp: 200,
      },
    ]);
    expect(readdirSync(join(dir, "agent-control"))).toEqual(["events.jsonl", "state.json"]);
  });

  it("persists valid state transitions and append-only lifecycle events", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-control-store-"));
    let now = 200;
    const store = new TaskStore(dir, () => now);
    store.createTask(task());

    now = 300;
    store.transition("task-1", "running", "agent started");

    expect(store.load().tasks["task-1"]).toMatchObject({ status: "running", updatedAt: 300 });
    expect(store.readEvents()).toHaveLength(2);
    expect(store.readEvents()[1]).toMatchObject({
      taskId: "task-1",
      previousStatus: "preparing",
      nextStatus: "running",
      reason: "agent started",
      timestamp: 300,
    });
  });

  it("persists a rejection, approval binding, and lifecycle event atomically", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-control-store-"));
    let now = 200;
    const store = new TaskStore(dir, () => now);
    const candidate: TaskRecord = {
      ...task(),
      status: "candidate_ready",
      baseSha: "b".repeat(40),
      targetBranch: "main",
      candidateBranch: "pi-agent-task-1",
      candidateSha: "a".repeat(40),
    };
    store.createTask(candidate);

    now = 300;
    const approval = captureCandidateApproval(candidate, "rejected", now);
    store.transitionWithPatch("task-1", "rejected", "user rejected candidate", { approval });

    expect(store.load().tasks["task-1"]).toMatchObject({
      status: "rejected",
      approval,
      candidateBranch: "pi-agent-task-1",
      candidateSha: "a".repeat(40),
    });
    expect(store.readEvents()[1]).toMatchObject({
      previousStatus: "candidate_ready",
      nextStatus: "rejected",
      reason: "user rejected candidate",
      timestamp: 300,
    });
  });

  it("persists candidate metadata atomically without faking a lifecycle transition", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-control-store-"));
    let now = 200;
    const store = new TaskStore(dir, () => now);
    store.createTask(task());

    now = 300;
    store.updateTask("task-1", {
      candidateBranch: "pi-agent-task-1",
      candidateSha: "a".repeat(40),
      changedFiles: ["src/index.ts"],
      validationCommands: ["npm test"],
    });

    expect(store.load().tasks["task-1"]).toMatchObject({
      status: "preparing",
      updatedAt: 300,
      candidateBranch: "pi-agent-task-1",
      candidateSha: "a".repeat(40),
      changedFiles: ["src/index.ts"],
    });
    expect(store.readEvents()).toEqual([
      expect.objectContaining({ nextStatus: "preparing", reason: "task created" }),
      expect.objectContaining({ previousStatus: "preparing", nextStatus: "preparing", reason: "task metadata updated" }),
    ]);
  });

  it("skips corrupt audit lines and invalid snapshot entries", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-control-store-"));
    const store = new TaskStore(dir, () => 200);
    store.createTask(task());
    appendFileSync(join(dir, "agent-control", "events.jsonl"), "not json\n", "utf-8");
    appendFileSync(join(dir, "agent-control", "events.jsonl"), `${JSON.stringify({ taskId: "task-1", nextStatus: 42, timestamp: 300 })}\n`, "utf-8");

    // createTask emits 1 valid event; 2 corrupt lines are skipped.
    expect(store.readEvents()).toHaveLength(1);

    const stateDir = join(dir, "agent-control");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({ version: 1, tasks: { "task-1": task(), broken: { id: "broken", status: "bogus" } } }),
      "utf-8",
    );
    expect(store.load().tasks["broken"]).toBeUndefined();
    expect(store.load().tasks["task-1"]).toBeDefined();
  });
});
