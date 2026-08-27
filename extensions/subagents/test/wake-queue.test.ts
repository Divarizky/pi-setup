import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowEventQueue } from "../src/workflow/wake-queue.ts";

test("workflow queue persists actionable wakes and ignores routine working events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-wake-"));
  try {
    const queue = new WorkflowEventQueue(root);
    await queue.restore();

    const routine = await queue.publish("task-1", {
      type: "status",
      status: "working",
      at: 100,
    });
    assert.equal(routine.wake, undefined);

    const blocked = await queue.publish("task-1", {
      type: "status",
      status: "blocked",
      message: "Needs parent decision",
      at: 110,
    });
    assert.ok(blocked.wake);
    assert.equal(queue.pending()[0]?.taskId, "task-1");
    assert.equal(queue.pending()[0]?.status, "blocked");

    const restored = new WorkflowEventQueue(root);
    await restored.restore();
    assert.equal(restored.pending().length, 1);
    assert.equal(restored.events("task-1").length, 2);

    await restored.acknowledge(blocked.wake!.id);
    assert.equal(restored.pending().length, 0);
    assert.equal(await restored.acknowledge(blocked.wake!.id), false);
    assert.match(
      await readFile(path.join(root, "workflow-events.jsonl"), "utf8"),
      /blocked/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow queue rebuilds missing wakes from its event log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-wake-"));
  try {
    const queue = new WorkflowEventQueue(root);
    await queue.restore();
    await queue.publish("task-1", {
      type: "status",
      status: "working",
      at: 100,
    });
    await queue.publish("task-1", {
      type: "status",
      status: "failed",
      message: "lost wake",
      at: 110,
    });
    await rm(path.join(root, "workflow-wakes.json"));
    const restored = new WorkflowEventQueue(root);
    await restored.restore();
    assert.equal(restored.pending()[0]?.message, "lost wake");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow queue rejects stale and skipped future generations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-wake-"));
  try {
    const queue = new WorkflowEventQueue(root);
    await queue.restore();
    await queue.publish("task-1", {
      type: "status",
      status: "working",
      generation: 1,
      at: 100,
    });
    await queue.publish("task-1", {
      type: "status",
      status: "done",
      generation: 1,
      at: 110,
    });
    await assert.rejects(
      queue.publish("task-1", {
        type: "status",
        status: "working",
        generation: 1,
        at: 120,
      }),
      /Invalid workflow transition/i,
    );
    await assert.rejects(
      queue.publish("task-1", {
        type: "status",
        status: "done",
        generation: 3,
        at: 130,
      }),
      /generation/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow queue migrates legacy reused task IDs into a new generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-wake-"));
  try {
    const eventsPath = path.join(root, "workflow-events.jsonl");
    await writeFile(
      eventsPath,
      [
        JSON.stringify({
          sequence: 1,
          taskId: "sa-15",
          event: { type: "status", status: "working", generation: 1, at: 100 },
        }),
        JSON.stringify({
          sequence: 2,
          taskId: "sa-15",
          event: { type: "status", status: "done", generation: 1, at: 110 },
        }),
        JSON.stringify({
          sequence: 3,
          taskId: "sa-15",
          event: { type: "status", status: "working", generation: 1, at: 120 },
        }),
        JSON.stringify({
          sequence: 4,
          taskId: "sa-15",
          event: {
            type: "status",
            status: "needs-decision",
            generation: 1,
            at: 130,
          },
        }),
      ].join("\n") + "\n",
    );

    const queue = new WorkflowEventQueue(root);
    await queue.restore();
    assert.equal(queue.status("sa-15"), "needs-decision");
    assert.deepEqual(
      queue.events("sa-15").map((record) => record.event.generation),
      [1, 1, 2, 2],
    );
    assert.match(await readFile(eventsPath, "utf8"), /"generation":2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow queue removes deleted task metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-wake-"));
  try {
    const queue = new WorkflowEventQueue(root);
    await queue.restore();
    await queue.publish("task-1", {
      type: "status",
      status: "working",
      at: 100,
    });
    await queue.publish("task-1", { type: "status", status: "done", at: 110 });
    await queue.removeTask("task-1");
    assert.equal(queue.events("task-1").length, 0);
    assert.equal(
      queue.pending().filter((wake) => wake.taskId === "task-1").length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow queue keeps separate wakes for repeated actionable generations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-wake-"));
  try {
    const queue = new WorkflowEventQueue(root);
    await queue.restore();
    await queue.publish("task-1", {
      type: "status",
      status: "working",
      at: 90,
    });
    await queue.publish("task-1", {
      type: "status",
      status: "failed",
      message: "first",
      at: 100,
    });
    await queue.publish("task-1", {
      type: "status",
      status: "working",
      generation: 2,
      at: 190,
    });
    await queue.publish("task-1", {
      type: "status",
      status: "unknown",
      generation: 2,
      message: "second",
      at: 200,
    });
    assert.deepEqual(
      queue.pending().map((wake) => wake.message),
      ["first", "second"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
