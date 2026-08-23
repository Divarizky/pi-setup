import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { OrcaSessionClient } from "../src/backends/orca.ts"
import { makeOrcaBackend } from "../src/backends/orca.ts"
import { BackendRegistry } from "../src/backend.ts"
import type { BackendName, ParentContext, SpawnTask } from "../src/domain.ts"
import { SubagentManager, SubagentManagerLive } from "../src/manager.ts"
import { runTool } from "../src/runtime.ts"

const parent: ParentContext = { parentCwd: process.cwd(), projectTrusted: true }

function task(jobId = "orca-job-1", mode: SpawnTask["mode"] = "build"): SpawnTask {
  return {
    jobId,
    prompt: "Inspect the isolated checkout",
    title: "Orca integration",
    cwd: "C:/fake/orca-job-1",
    mode,
    worktree: {
      jobId,
      repoRoot: "C:/fake/repo",
      path: `C:/fake/${jobId}`,
      branch: `subagent/${jobId}`,
    },
    parent,
  }
}

test("Orca backend runs through the manager with mocked terminal CLI", async () => {
  const calls: string[] = []
  let terminalNumber = 0
  let currentWorktreePath = ""
  let currentHandle = ""
  let currentWorktreeId = ""
  const terminals = new Map<string, { handle: string; worktreeId: string; worktreePath: string; tabId?: string; paneKey?: string; sessionId?: string; launchToken?: string; connected: boolean; writable: boolean; orphaned: boolean }>()
  let cleanChecks = 0
  const createdModes: string[] = []
  const client: OrcaSessionClient = {
    createPiTerminal: async ({ worktreePath, mode }) => {
      const number = ++terminalNumber
      currentWorktreePath = worktreePath
      currentHandle = `term-${number}`
      currentWorktreeId = `wt-${number}`
      terminals.set(currentHandle, { handle: currentHandle, worktreeId: currentWorktreeId, worktreePath, tabId: `tab-${number}`, paneKey: `pane-${number}`, sessionId: `pi-session-${number}`, connected: true, writable: true, orphaned: false })
      createdModes.push(mode ?? "build")
      calls.push(`create:${worktreePath}`)
      return { handle: `term-${number}`, worktreeId: `wt-${number}`, tabId: `tab-${number}`, paneKey: `pane-${number}`, sessionId: `pi-session-${number}` }
    },
    listTerminals: async () => [...terminals.values()],
    read: async () => ({
      text: "<subagent-report>{\"outcome\":\"success\",\"summary\":\"Orca finished\",\"changes\":[],\"tests\":[],\"needsParentDecision\":false}</subagent-report>",
    }),
    send: async (_handle, text) => { calls.push(`send:${text}`) },
    waitForIdle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      calls.push("idle")
    },
    stop: async (worktreeId) => { calls.push(`stop:${worktreeId}`) },
    assertWorktreeClean: async () => { cleanChecks++ },
  }
  const backend = makeOrcaBackend(client)
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(
      Effect.gen(function* () { return yield* SubagentManager }),
    )
    const spawned = await runTool(runtime, manager.spawn("orca", task()))
    assert.equal(spawned.id, "orca-job-1")
    const evidence = await runTool(runtime, manager.probeStatuses())
    assert.equal(evidence[0]?.status, "unknown")
    await runTool(runtime, manager.waitFor([spawned.id]))
    const done = manager.view.get(spawned.id)
    assert.equal(done?.status, "done")
    assert.equal(done?.meta.nativeSessionId, "pi-session-1")
    assert.equal(done?.meta.nativeTerminalHandle, "term-1")
    assert.equal(done?.meta.nativePaneKey, "pane-1")
    assert.equal(done?.meta.nativeWorktreeId, "wt-1")
    assert.equal(done?.meta.nativeTabId, "tab-1")
    assert.equal(calls[0], "create:C:/fake/orca-job-1")
    assert.match(calls[1] ?? "", /You are a build subagent/)
    assert.match(calls[1] ?? "", /Inspect the isolated checkout/)
    assert.equal(calls[2], "idle")
    assert.deepEqual(await runTool(runtime, manager.probeStatuses()), [])

    await assert.rejects(
      runTool(runtime, manager.spawn("orca", task("scout-job", "scout"))),
      /Scout only supports the Pi backend/i,
    )
    assert.equal(cleanChecks, 0)
    assert.equal(createdModes[0], "build")

    const beforeAgentFirst = calls.length
    const agentFirst = await runTool(runtime, manager.spawn("orca", {
      ...task("agent-first-job"),
      initialTerminal: { handle: "term-agent-first", worktreeId: "wt-agent-first" },
    }))
    await runTool(runtime, manager.waitFor([agentFirst.id]))
    assert.equal(calls.slice(beforeAgentFirst).some((call) => call === "send:Inspect the isolated checkout"), false)

    await runTool(runtime, manager.restore([{
      jobId: "restored-orca",
      backend: "orca",
      nativeSessionId: "pi-session-1",
      nativeTerminalHandle: "term-1",
      nativeWorktreeId: "wt-1",
      nativeTabId: "tab-1",
      title: "Restored Orca job",
      mode: "build",
      cwd: "C:/fake/restored-orca",
      status: "running",
      createdAt: 1,
      worktreePath: "C:/fake/orca-job-1",
      branch: "subagent/restored-orca",
      repoRoot: "C:/fake/repo",
    }]))
    const reattached = await runTool(runtime, manager.reattach("restored-orca"))
    assert.equal(reattached.status, "running")
    assert.equal(reattached.meta.nativeTerminalHandle, "term-1")
    await runTool(runtime, manager.cancel(["restored-orca"]))

    const interrupted = await runTool(runtime, manager.spawn("orca", task("orca-job-2")))
    await runTool(runtime, manager.cancel([interrupted.id]))
    assert.equal(manager.view.get(interrupted.id)?.status, "error")
    await runTool(runtime, manager.retry(interrupted.id, "Recover in the same worktree."))
    await runTool(runtime, manager.waitFor([interrupted.id]))
    assert.equal(manager.view.get(interrupted.id)?.status, "done")
    assert.equal(manager.view.get(interrupted.id)?.meta.nativeSessionId, "pi-session-3")
    assert.equal(calls.filter((call) => call.startsWith("create:")).length, 3)
  } finally {
    await runtime.dispose()
  }
})

test("Orca backend reads full scrollback via cursor pagination", async () => {
  const pages = new Map<number, { lines: string[]; nextCursor?: number }>([
    [0, { lines: ["working..."], nextCursor: 1 }],
    [1, { lines: ["<subagent-report>{\"outcome\":\"success\",\"summary\":\"paged done\",\"changes\":[],\"tests\":[],\"needsParentDecision\":false}</subagent-report>"] }],
  ])
  const readCursors: Array<number | undefined> = []
  const client: OrcaSessionClient = {
    createPiTerminal: async () => ({ handle: "term-paged", worktreeId: "wt-paged" }),
    listTerminals: async () => [{ handle: "term-paged", worktreeId: "wt-paged", worktreePath: "C:/fake/paged-job", connected: true, writable: true, orphaned: false }],
    read: async (_handle, options = {}) => {
      readCursors.push(options.cursor)
      const page = pages.get(options.cursor ?? 0)
      if (!page) throw new Error(`Unexpected page ${options.cursor}`)
      return page
    },
    send: async () => {},
    waitForIdle: async () => {},
    stop: async () => {},
  }
  const backend = makeOrcaBackend(client, { stableIdleMs: 1 })
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(Effect.gen(function* () { return yield* SubagentManager }))
    const spawned = await runTool(runtime, manager.spawn("orca", task("paged-job")))
    await runTool(runtime, manager.waitFor([spawned.id]))
    const snap = manager.view.get(spawned.id)
    assert.equal(snap?.status, "done")
    assert.match(snap?.report?.summary ?? "", /paged done/)
    assert.deepEqual(readCursors, [undefined, 1])
  } finally {
    await runtime.dispose()
  }
})

test("Orca backend nudges once when the structured report is missing", async () => {
  let sendCount = 0
  const client: OrcaSessionClient = {
    createPiTerminal: async () => ({ handle: "term-nudge", worktreeId: "wt-nudge" }),
    listTerminals: async () => [{ handle: "term-nudge", worktreeId: "wt-nudge", worktreePath: "C:/fake/nudge-job", connected: true, writable: true, orphaned: false }],
    read: async () => sendCount === 0
      ? { lines: ["work finished but no report yet"] }
      : { text: '<subagent-report>{"outcome":"success","summary":"nudged report","changes":[],"tests":[],"needsParentDecision":false}</subagent-report>' },
    send: async (_handle, text) => {
      sendCount++
      assert.match(text, /<subagent-report>/)
    },
    waitForIdle: async () => {},
    stop: async () => {},
  }
  const backend = makeOrcaBackend(client, { stableIdleMs: 1 })
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(Effect.gen(function* () { return yield* SubagentManager }))
    const spawned = await runTool(runtime, manager.spawn("orca", task("nudge-job")))
    await runTool(runtime, manager.waitFor([spawned.id]))
    const snap = manager.view.get(spawned.id)
    assert.equal(snap?.status, "done")
    assert.match(snap?.report?.summary ?? "", /nudged report/)
    assert.equal(sendCount, 1)
  } finally {
    await runtime.dispose()
  }
})

test("Orca backend reports API overload as a retryable failure", async () => {
  const client: OrcaSessionClient = {
    createPiTerminal: async () => ({ handle: "term-overload", worktreeId: "wt-overload" }),
    listTerminals: async () => [{ handle: "term-overload", worktreeId: "wt-overload", worktreePath: "C:/fake/overload-job", connected: true, writable: true, orphaned: false }],
    read: async () => ({ lines: ["Error: Service temporarily overloaded"] }),
    send: async () => {},
    waitForIdle: async () => {},
    stop: async () => {},
  }
  const backend = makeOrcaBackend(client, { stableIdleMs: 1 })
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(Effect.gen(function* () { return yield* SubagentManager }))
    const spawned = await runTool(runtime, manager.spawn("orca", task("overload-job")))
    await runTool(runtime, manager.waitFor([spawned.id]))
    const snap = manager.view.get(spawned.id)
    assert.equal(snap?.status, "error")
    assert.match(snap?.errorText ?? "", /overloaded/i)
    assert.match(snap?.errorText ?? "", /subagent_retry/i)
  } finally {
    await runtime.dispose()
  }
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("Orca backend waits through slow Pi startup before settling", async () => {
  let lastSent = ""
  let reads = 0
  let created = 0
  const client: OrcaSessionClient = {
    createPiTerminal: async () => {
      created++
      await delay(80)
      return { handle: "term-slow", worktreeId: "wt-slow" }
    },
    listTerminals: async () => [{ handle: "term-slow", worktreeId: "wt-slow", worktreePath: "C:/fake/slow-job", connected: true, writable: true, orphaned: false }],
    // Simulate slow Pi boot: the scrollback shows only our own prompt echo at first.
    read: async () => {
      reads++
      return reads <= 3 ? { lines: [lastSent] } : { text: '<subagent-report>{"outcome":"success","summary":"slow start done","changes":[],"tests":[],"needsParentDecision":false}</subagent-report>' }
    },
    send: async (_handle, text) => { lastSent = text },
    waitForIdle: async () => {},
    stop: async () => {},
  }
  const backend = makeOrcaBackend(client, { stableIdleMs: 1 })
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(Effect.gen(function* () { return yield* SubagentManager }))
    const spawned = await runTool(runtime, manager.spawn("orca", task("slow-job")))
    await runTool(runtime, manager.waitFor([spawned.id]))
    const snap = manager.view.get(spawned.id)
    assert.equal(created, 1)
    assert.equal(snap?.status, "done")
    assert.match(snap?.report?.summary ?? "", /slow start done/)
    assert.ok(reads >= 4, `expected repeated probing during startup, got ${reads} reads`)
  } finally {
    await runtime.dispose()
  }
})

test("Orca backend ignores a shell-escaped launch-prompt echo", async () => {
  let lastSent = ""
  let reads = 0
  const client: OrcaSessionClient = {
    createPiTerminal: async () => ({ handle: "term-escaped-echo", worktreeId: "wt-escaped-echo" }),
    listTerminals: async () => [{ handle: "term-escaped-echo", worktreeId: "wt-escaped-echo", worktreePath: "C:/fake/escaped-echo-job", connected: true, writable: true, orphaned: false }],
    read: async () => {
      reads++
      if (reads <= 3) {
        // Orca can render an argv prompt as a shell-escaped one-line command.
        return { lines: [`$ pi '${lastSent.replace(/\\n/g, "\\\\n")}'`] }
      }
      return { text: '<subagent-report>{"outcome":"success","summary":"escaped echo ignored","changes":[],"tests":[],"needsParentDecision":false}</subagent-report>' }
    },
    send: async (_handle, text) => { lastSent = text },
    waitForIdle: async () => {},
    stop: async () => {},
  }
  const backend = makeOrcaBackend(client, { stableIdleMs: 1 })
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(Effect.gen(function* () { return yield* SubagentManager }))
    const spawned = await runTool(runtime, manager.spawn("orca", task("escaped-echo-job")))
    await runTool(runtime, manager.waitFor([spawned.id]))
    assert.equal(manager.view.get(spawned.id)?.status, "done")
    assert.match(manager.view.get(spawned.id)?.report?.summary ?? "", /escaped echo ignored/)
    assert.ok(reads >= 4, `expected the launch echo to remain in startup, got ${reads} reads`)
  } finally {
    await runtime.dispose()
  }
})

test("Orca backend settles startup silence as a retryable failure", async () => {
  let lastSent = ""
  let recovered = false
  const client: OrcaSessionClient = {
    createPiTerminal: async () => ({ handle: "term-stuck", worktreeId: "wt-stuck" }),
    listTerminals: async () => [{ handle: "term-stuck", worktreeId: "wt-stuck", worktreePath: "C:/fake/stuck-job", connected: true, writable: true, orphaned: false }],
    read: async () => recovered
      ? { text: '<subagent-report>{"outcome":"success","summary":"recovered","changes":[],"tests":[],"needsParentDecision":false}</subagent-report>' }
      : { lines: [lastSent] },
    send: async (_handle, text) => {
      lastSent = text
      if (/^Retry this job/.test(text)) recovered = true
    },
    waitForIdle: async () => {},
    stop: async () => {},
  }
  const backend = makeOrcaBackend(client, { stableIdleMs: 1, startupTimeoutMs: 250 })
  const registry = Layer.sync(BackendRegistry, () => new Map<BackendName, typeof backend>([["orca", backend]]))
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)))
  try {
    const manager = await runtime.runPromise(Effect.gen(function* () { return yield* SubagentManager }))
    const spawned = await runTool(runtime, manager.spawn("orca", task("stuck-job")))
    await runTool(runtime, manager.waitFor([spawned.id]))
    const snap = manager.view.get(spawned.id)
    assert.equal(snap?.status, "error")
    assert.match(snap?.errorText ?? "", /subagent_retry/i)
    await runTool(runtime, manager.retry(spawned.id))
    await runTool(runtime, manager.waitFor([spawned.id]))
    assert.equal(manager.view.get(spawned.id)?.status, "done")
    assert.match(manager.view.get(spawned.id)?.report?.summary ?? "", /recovered/)
  } finally {
    await runtime.dispose()
  }
})

test("Orca backend refuses terminal control without a worktree id", async () => {
  const backend = makeOrcaBackend({
    createPiTerminal: async () => ({ handle: "term-unscoped" }),
    listTerminals: async () => [],
    read: async () => ({}),
    send: async () => {},
    waitForIdle: async () => {},
    stop: async () => {},
  })
  await assert.rejects(
    Effect.runPromise(Effect.scoped(backend.spawn(task("orca-unscoped")))),
    /worktree id/i,
  )
})
