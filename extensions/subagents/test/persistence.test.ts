import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobPersistence, PersistenceError } from "../src/persistence.ts";
import type { ApprovalRequest } from "../src/approval.ts";

test("job persistence survives a new store instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-state-"));
  try {
    const first = new JobPersistence(root);
    await first.upsert({
      jobId: "job-1",
      origin: "model",
      title: "build feature",
      mode: "build",
      cwd: "/repo/worktree",
      status: "running",
      createdAt: 100,
      branch: "subagent/job-1",
      sessionFilePath: "/agent/sessions/child.jsonl",
      nativeSessionId: "term-1",
      nativeTerminalHandle: "term-1",
      nativeWorktreeId: "wt-1",
      nativeTabId: "tab-1",
    });
    await first.appendEvent({ at: 101, jobId: "job-1", event: "started" });

    const restoredStore = new JobPersistence(root);
    const events = await restoredStore.loadEvents();
    assert.deepEqual(events, [{ at: 101, jobId: "job-1", event: "started" }]);
    const restored = await restoredStore.load();
    assert.deepEqual(restored[0], {
      jobId: "job-1",
      origin: "model",
      title: "build feature",
      mode: "build",
      cwd: "/repo/worktree",
      status: "running",
      createdAt: 100,
      branch: "subagent/job-1",
      sessionFilePath: "/agent/sessions/child.jsonl",
      nativeSessionId: "term-1",
      nativeTerminalHandle: "term-1",
      nativeWorktreeId: "wt-1",
      nativeTabId: "tab-1",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job persistence preserves quick-ask origin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-state-origin-"));
  try {
    const store = new JobPersistence(root);
    await store.upsert({
      jobId: "qa-1",
      origin: "quick-ask",
      title: "side question",
      mode: "scout",
      cwd: "/repo",
      status: "done",
      createdAt: 100,
    });
    assert.equal(
      (await new JobPersistence(root).load())[0]?.origin,
      "quick-ask",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job persistence preserves the structured report and final output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-state-report-"));
  try {
    const store = new JobPersistence(root);
    await store.upsert({
      jobId: "job-report",
      title: "report task",
      mode: "build",
      cwd: "/repo/worktree",
      status: "done",
      createdAt: 100,
      finalText: "final output",
      report: {
        outcome: "success",
        summary: "Completed cleanly.",
        changes: ["src/example.ts"],
        tests: [{ command: "npm test", passed: true }],
        needsParentDecision: false,
      },
    });
    const restored = await new JobPersistence(root).load();
    assert.equal(restored[0]?.finalText, "final output");
    assert.deepEqual(restored[0]?.report, {
      outcome: "success",
      summary: "Completed cleanly.",
      changes: ["src/example.ts"],
      tests: [{ command: "npm test", passed: true }],
      needsParentDecision: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a job removes its durable history but preserves other jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-state-delete-"));
  try {
    const store = new JobPersistence(root);
    await store.upsert({
      jobId: "delete-me",
      title: "delete",
      mode: "build",
      cwd: "/a",
      status: "done",
      createdAt: 1,
    });
    await store.upsert({
      jobId: "keep-me",
      title: "keep",
      mode: "build",
      cwd: "/b",
      status: "done",
      createdAt: 2,
    });
    await store.appendEvent({ at: 3, jobId: "delete-me", event: "done" });
    await store.appendEvent({ at: 4, jobId: "keep-me", event: "done" });
    await store.deleteJob("delete-me");
    assert.deepEqual(
      (await store.load()).map((job) => job.jobId),
      ["keep-me"],
    );
    assert.deepEqual(await store.loadEvents(), [
      { at: 4, jobId: "keep-me", event: "done" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleted jobs cannot be recreated by late persistence callbacks", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-job-state-delete-race-"),
  );
  try {
    const store = new JobPersistence(root);
    await store.deleteJob("job-1");
    await store.upsert({
      jobId: "job-1",
      title: "late",
      mode: "build",
      cwd: "/a",
      status: "done",
      createdAt: 1,
    });
    await store.appendEvent({ at: 2, jobId: "job-1", event: "late" });
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await store.loadEvents(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval state survives a new store instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-approval-state-"));
  try {
    const store = new JobPersistence(root);
    const approval: ApprovalRequest = {
      id: "approval:job-1:commit",
      jobId: "job-1",
      operation: "commit",
      status: "approved",
      requestedAt: 100,
      decidedAt: 101,
      decidedBy: "human",
    };
    await store.saveApprovals([approval]);
    assert.deepEqual(await new JobPersistence(root).loadApprovals(), [
      approval,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent job and approval writes preserve every latest record", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-job-state-concurrent-"),
  );
  try {
    const store = new JobPersistence(root);
    await Promise.all([
      store.upsert({
        jobId: "job-a",
        title: "a",
        mode: "build",
        cwd: "/a",
        status: "done",
        createdAt: 1,
      }),
      store.upsert({
        jobId: "job-b",
        title: "b",
        mode: "scout",
        cwd: "/b",
        status: "done",
        createdAt: 2,
      }),
      store.saveApprovals([
        {
          id: "approval:a:commit",
          jobId: "a",
          operation: "commit",
          status: "pending",
          requestedAt: 1,
        },
      ]),
      store.saveApprovals([
        {
          id: "approval:b:commit",
          jobId: "b",
          operation: "commit",
          status: "pending",
          requestedAt: 2,
        },
      ]),
    ]);
    assert.equal((await store.load()).length, 2);
    assert.equal((await store.loadApprovals()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed state fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-state-malformed-"));
  try {
    const store = new JobPersistence(root);
    await writeFile(store.statePath, "{not-json", "utf8");
    await assert.rejects(store.load(), PersistenceError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
