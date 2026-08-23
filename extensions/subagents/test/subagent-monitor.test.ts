import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ActionQueue } from "../src/action-queue.ts"
import type { SubagentSnapshot } from "../src/domain.ts"
import { SubagentMonitor, classifyStatus } from "../src/subagent-monitor.ts"

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "test job",
    prompt: "inspect",
    cwd: process.cwd(),
    status: "running",
    createdAt: 1,
    metrics: {
      runCount: 1,
      restartCount: 0,
      timeoutCount: 0,
      startedAt: 1,
      lastEventAt: 995,
    },
    eventLog: [],
    meta: { backend: "pi", mode: "build" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 1,
    ...overrides,
  }
}

test("subagent monitor emits durable action events for settlement and failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-monitor-settlement-"))
  try {
    const queue = new ActionQueue(root)
    const monitor = new SubagentMonitor(queue, { now: () => 1_000 })
    assert.deepEqual(await monitor.observe(snapshot()), [])

    const settled = snapshot({
      status: "done",
      settledAt: 1_010,
      meta: { backend: "pi", mode: "build", worktree: {
        jobId: "sa-1", path: "C:/worktree", branch: "subagent/sa-1", repoRoot: "C:/repo",
      } },
    })
    const actions = await monitor.observe(settled)
    assert.deepEqual(actions.map((item) => item.event.type), ["job_settled", "approval_required"])
    assert.deepEqual(await monitor.observe(settled), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("monitor preserves prior status when manager mutates a snapshot in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-monitor-mutable-"))
  try {
    const monitor = new SubagentMonitor(new ActionQueue(root), { now: () => 1_000 })
    const current = snapshot()
    await monitor.observe(current)
    const mutable = current as unknown as { status: "running" | "done"; settledAt?: number; meta: SubagentSnapshot["meta"] }
    mutable.status = "done"
    mutable.settledAt = 1_010
    mutable.meta = { backend: "pi", mode: "build", worktree: {
      jobId: "sa-1", path: "C:/worktree", branch: "subagent/sa-1", repoRoot: "C:/repo",
    } }
    const actions = await monitor.observe(current)
    assert.deepEqual(actions.map((item) => item.event.type), ["job_settled", "approval_required"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("external dead evidence creates one durable session action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-monitor-external-"))
  try {
    const monitor = new SubagentMonitor(new ActionQueue(root), { now: () => 1_000 })
    const evidence = { jobId: "sa-1", status: "dead" as const, source: "orca", at: 900, eventName: "session_disconnected" }
    assert.equal((await monitor.observeEvidence(evidence))[0]?.event.type, "session_dead")
    assert.deepEqual(await monitor.observeEvidence(evidence), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("subagent monitor detects stale evidence and restart errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-monitor-status-"))
  try {
    const queue = new ActionQueue(root)
    const monitor = new SubagentMonitor(queue, { now: () => 1_000, staleAfterMs: 100 })
    assert.equal(classifyStatus(snapshot({ metrics: {
      runCount: 1, restartCount: 0, timeoutCount: 0, startedAt: 1, lastEventAt: 950,
    } }), 1_000, 100), "busy")
    await monitor.observe(snapshot({ metrics: {
      runCount: 1, restartCount: 0, timeoutCount: 0, startedAt: 1, lastEventAt: 950,
    } }))
    const unknown = await monitor.observe(snapshot({ metrics: {
      runCount: 1, restartCount: 0, timeoutCount: 0, startedAt: 1, lastEventAt: 800,
    }}))
    assert.equal(unknown[0]?.event.type, "status_unknown")

    const recovered = await new SubagentMonitor(new ActionQueue(path.join(root, "recovered")), { now: () => 1_000 })
      .observe(snapshot({ status: "error", errorText: "Job was running when the agent restarted; recovery is required." }))
    assert.equal(recovered[0]?.event.type, "recovery_required")

    const transitionedMonitor = new SubagentMonitor(new ActionQueue(path.join(root, "transitioned")), { now: () => 1_000 })
    await transitionedMonitor.observe(snapshot())
    const transitioned = await transitionedMonitor.observe(snapshot({
      status: "error",
      errorText: "recovery_required: terminal disconnected",
    }))
    assert.equal(transitioned[0]?.event.type, "recovery_required")

    const conflictMonitor = new SubagentMonitor(new ActionQueue(path.join(root, "conflict")), { now: () => 1_000 })
    await conflictMonitor.observe(snapshot())
    const conflict = await conflictMonitor.observeEvidence({
      jobId: "sa-1", status: "idle", source: "orca", at: 1_000, eventName: "agent_end",
    })
    assert.equal(conflict[0]?.event.type, "status_unknown")

    const mismatchMonitor = new SubagentMonitor(new ActionQueue(path.join(root, "mismatch")), { now: () => 1_000 })
    const mismatch = await mismatchMonitor.observeEvidence({
      jobId: "sa-1", status: "busy", source: "orca", at: 1_000,
      eventName: "agent_start", identityVerified: false,
    })
    assert.equal(mismatch[0]?.event.type, "identity_mismatch")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
