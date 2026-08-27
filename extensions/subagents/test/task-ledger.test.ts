import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OrchestrationCoordinator } from "../src/workflow/coordinator.ts";
import { TaskLedger } from "../src/workflow/task-ledger.ts";

test("task ledger persists tasks, deduplicates events, and acknowledges them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-ledger-"));
  try {
    const ledger = new TaskLedger(root);
    await ledger.ensure({
      id: "task-1",
      title: "Inspect docs",
      mode: "scout",
      role: "worker",
      dependsOn: [],
      priority: 1,
      requiresWorktree: false,
      leadAgentId: "lead-docs",
    });
    await ledger.status("task-1", "working");
    await ledger.status("task-1", "done");
    const event = {
      eventId: "event-1",
      type: "worker_done" as const,
      actorId: "worker-1",
      leadAgentId: "lead-docs",
      taskId: "task-1",
      at: 100,
      summary: "Documentation review completed.",
    };
    assert.equal((await ledger.append(event)).duplicate, false);
    assert.equal((await ledger.append(event)).duplicate, true);
    assert.equal(ledger.pendingEvents().length, 1);
    assert.equal(await ledger.acknowledgeEvent("event-1"), true);

    const restored = new TaskLedger(root);
    await restored.restore();
    assert.equal(restored.get("task-1")?.status, "done");
    assert.equal(restored.pendingEvents().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestration coordinator handles each event once", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "task-ledger-coordinator-"),
  );
  try {
    const ledger = new TaskLedger(root);
    const handled: string[] = [];
    const coordinator = new OrchestrationCoordinator(ledger, async (event) => {
      handled.push(event.eventId);
    });
    const event = {
      eventId: "event-coordinator-1",
      type: "escalation" as const,
      actorId: "lead-1",
      leadAgentId: "lead-docs",
      taskId: "task-1",
      at: 100,
      reason: "Needs parent decision.",
    };
    assert.deepEqual(await coordinator.emit(event), { duplicate: false });
    assert.deepEqual(await coordinator.emit(event), { duplicate: true });
    assert.deepEqual(handled, ["event-coordinator-1"]);
    assert.equal(ledger.pendingEvents().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
