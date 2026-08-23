import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ActionQueue, ActionQueueError } from "../src/action-queue.ts"

test("action queue persists events and action receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-action-queue-"))
  try {
    const first = new ActionQueue(root)
    const event = await first.enqueue({
      actionId: "action:job-1:job_settled:10",
      jobId: "job-1",
      type: "job_settled",
      at: 10,
      message: "Review completed job.",
    })
    assert.equal(event.status, "pending")
    await first.confirm(event.event.actionId)

    const restored = new ActionQueue(root)
    await restored.restore()
    assert.equal(restored.list("confirmed").length, 1)
    assert.equal((await restored.confirm(event.event.actionId)).status, "confirmed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("deleted jobs cannot be recreated by late action callbacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-action-queue-delete-"))
  try {
    const queue = new ActionQueue(root)
    await queue.enqueue({
      actionId: "action:job-1:job_settled:10",
      jobId: "job-1",
      type: "job_settled",
      at: 10,
      message: "Review completed job.",
    })
    await queue.deleteJob("job-1")
    await assert.rejects(
      queue.enqueue({
        actionId: "action:job-1:job_failed:11",
        jobId: "job-1",
        type: "job_failed",
        at: 11,
        message: "Late callback.",
      }),
      /Job was deleted/,
    )
    assert.equal(queue.list().length, 0)
    const restored = new ActionQueue(root)
    await restored.restore()
    assert.equal(restored.list().length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("malformed action queue fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-action-queue-malformed-"))
  try {
    const queue = new ActionQueue(root)
    await writeFile(queue.filePath, "{bad-json}\n", "utf8")
    await assert.rejects(queue.restore(), ActionQueueError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
