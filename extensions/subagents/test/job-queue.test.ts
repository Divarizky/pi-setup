import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { JobQueue } from "../src/job-queue.ts"
import type { SpawnTask } from "../src/domain.ts"

const task = (id: string): SpawnTask => ({
  jobId: id,
  title: id,
  prompt: "inspect",
  cwd: process.cwd(),
  mode: "scout",
  parent: { parentCwd: process.cwd(), projectTrusted: true },
})

test("job queue orders ready jobs and rejects dependency cycles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-queue-"))
  try {
    const queue = new JobQueue(root)
    await queue.enqueue({ id: "first", title: "first", backend: "pi", mode: "scout", dependsOn: [], priority: 1, task: task("first") })
    await queue.enqueue({ id: "second", title: "second", backend: "pi", mode: "scout", dependsOn: ["first"], priority: 5, task: task("second") })
    await queue.enqueue({ id: "third", title: "third", backend: "pi", mode: "scout", dependsOn: [], priority: 10, task: task("third") })
    assert.deepEqual(queue.ready((id) => id === "first" || id === "third").map((job) => job.id), ["third", "second", "first"])
    await assert.rejects(
      queue.enqueue({ id: "cycle", title: "cycle", backend: "pi", mode: "scout", dependsOn: ["cycle"], priority: 0, task: task("cycle") }),
      /cannot depend on itself/,
    )
    await queue.mark("first", "done")
    assert.deepEqual(queue.ready((id) => id === "first").map((job) => job.id), ["third", "second"] )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removing a dependency blocks dependents instead of leaving an orphan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-delete-dependency-"))
  try {
    const queue = new JobQueue(root)
    await queue.enqueue({ id: "first", title: "first", backend: "pi", mode: "scout", dependsOn: [], priority: 0, task: task("first") })
    await queue.enqueue({ id: "second", title: "second", backend: "pi", mode: "scout", dependsOn: ["first"], priority: 0, task: task("second") })
    await queue.remove("first")
    assert.equal(queue.get("first"), undefined)
    assert.equal(queue.get("second")?.status, "blocked")
    assert.match(queue.get("second")?.errorText ?? "", /Dependency first was deleted/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("job queue restores durable records fail closed for active jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-job-restore-"))
  try {
    const queue = new JobQueue(root)
    await queue.enqueue({ id: "persisted", title: "persisted", backend: "pi", mode: "scout", dependsOn: [], priority: 0, task: task("persisted") })
    await queue.mark("persisted", "running")
    await queue.enqueue({ id: "waiting", title: "waiting", backend: "pi", mode: "scout", dependsOn: [], priority: 0, task: task("waiting") })
    const restored = new JobQueue(root)
    await restored.restore()
    assert.equal(restored.get("persisted")?.status, "blocked")
    assert.equal(restored.get("waiting")?.status, "blocked")
    assert.match(restored.get("waiting")?.errorText ?? "", /re-enqueue/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
