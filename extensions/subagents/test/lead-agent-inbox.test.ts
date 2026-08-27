import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LeadAgentInbox } from "../src/workflow/lead-agent-inbox.ts";
import type { LeadAgentEvent } from "../src/workflow/orchestration.ts";

const event: LeadAgentEvent = {
  eventId: "event-1",
  type: "ask",
  actorId: "lead-job",
  leadAgentId: "lead-1",
  taskId: "task-1",
  question: "Need a decision",
  at: 100,
};

test("Lead Agent inbox transfers child events without the runtime state lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-lead-inbox-"));
  try {
    const inbox = new LeadAgentInbox(root);
    await inbox.enqueue(event);
    const received: LeadAgentEvent[] = [];
    assert.equal(
      await inbox.drain(async (item) => {
        received.push(item);
      }),
      1,
    );
    assert.deepEqual(received, [event]);
    await assert.rejects(readFile(inbox.filePath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Lead Agent inbox restores unprocessed events after a handler failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-lead-inbox-"));
  try {
    const inbox = new LeadAgentInbox(root);
    await inbox.enqueue(event);
    await inbox.enqueue({ ...event, eventId: "event-2" });
    await assert.rejects(
      inbox.drain(async (item) => {
        if (item.eventId === "event-2") throw new Error("temporary");
      }),
      /temporary/,
    );
    const received: LeadAgentEvent[] = [];
    assert.equal(
      await inbox.drain(async (item) => {
        received.push(item);
      }),
      1,
    );
    assert.equal(received[0]?.eventId, "event-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
