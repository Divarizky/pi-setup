import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { SubagentBackend } from "../src/backend.ts";
import type { PersistedJob } from "../src/persistence.ts";
import { BackendRegistry } from "../src/backend.ts";
import { makeStubBackend } from "../src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "../src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "../src/manager.ts";
import { runTool } from "../src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "pi/model",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 20,
    }),
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "pi/model-secondary",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 15,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("restored jobs remain visible and running jobs fail closed as orphaned", async () => {
  await withManager(async (manager, runtime) => {
    const jobs: PersistedJob[] = [
      {
        jobId: "sa-7",
        origin: "quick-ask",
        title: "old build",
        mode: "build",
        cwd: process.cwd(),
        backend: "orca",
        nativeSessionId: "term-restored",
        nativeTerminalHandle: "term-restored",
        nativeWorktreeId: "wt-restored",
        nativeTabId: "tab-restored",
        status: "done",
        createdAt: 10,
        settledAt: 20,
      },
      {
        jobId: "sa-8",
        title: "interrupted build",
        mode: "build",
        cwd: process.cwd(),
        status: "running",
        createdAt: 30,
      },
    ];

    await runTool(
      runtime,
      manager.restore(jobs, [
        { at: 15, jobId: "sa-7", event: "spawned" },
        { at: 19, jobId: "sa-7", event: "settled", message: "done" },
      ]),
    );
    assert.equal(manager.view.get("sa-7")?.status, "done");
    assert.equal(manager.view.get("sa-7")?.origin, "quick-ask");
    assert.equal(manager.view.get("sa-7")?.backend, "orca");
    assert.equal(
      manager.view.get("sa-7")?.meta.nativeTerminalHandle,
      "term-restored",
    );
    assert.equal(
      manager.view.get("sa-7")?.meta.nativeWorktreeId,
      "wt-restored",
    );
    assert.deepEqual(manager.view.get("sa-7")?.eventLog.slice(0, 2), [
      { at: 15, event: "spawned" },
      { at: 19, event: "settled", message: "done" },
    ]);
    assert.equal(manager.view.get("sa-8")?.status, "failed");
    assert.match(manager.view.get("sa-8")?.errorText ?? "", /restarted/);
    assert.equal(await runTool(runtime, manager.hasLiveSession("sa-8")), false);
    assert.equal(manager.view.size(), 2);

    const next = await runTool(
      runtime,
      manager.spawn("pi", task("avoid restored id")),
    );
    assert.equal(next.id, "sa-9");
  });
});

test("failed subagents retry with bounded recovery", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("FAIL: first attempt")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "failed");

    await runTool(runtime, manager.retry(snap.id, "Recover without failing."));
    await runTool(runtime, manager.waitFor([snap.id]));
    const recovered = manager.view.get(snap.id);
    assert.equal(recovered?.status, "done");
    assert.equal(recovered?.metrics.restartCount, 1);
  });
});

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "pi");
    assert.ok(snap.meta.sessionFilePath);
    assert.equal(await runTool(runtime, manager.hasLiveSession(snap.id)), true);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:pi\] completed: Say hello to the tests/,
    );
    assert.equal(done.report?.outcome, "success");
    assert.deepEqual(done.report?.changes, ["updated test fixture"]);
    assert.equal(done.report?.tests[0]?.passed, true);
    assert.equal(done.metrics.runCount, 1);
    assert.equal(done.metrics.timeoutCount, 0);
    assert.ok(done.eventLog.some((event) => event.event === "RunStarted"));
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as failed; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("FAIL: blow up please")),
    );
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "failed", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("recovery-required preserves the job and permits a bounded retry", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Recover after terminal loss")),
    );
    await runTool(
      runtime,
      manager.markRecoveryRequired(snap.id, "terminal disconnected"),
    );
    const dead = manager.view.get(snap.id);
    assert.equal(dead?.status, "failed");
    assert.match(dead?.errorText ?? "", /recovery_required/);
    assert.ok(
      dead?.eventLog.some((event) => event.event === "RecoveryRequired"),
    );

    await runTool(
      runtime,
      manager.retry(snap.id, "Continue from the preserved worktree."),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "done");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("pi", task("model task")),
    );
    const qa = await runTool(
      runtime,
      manager.spawn("pi", { ...task("side question"), origin: "quick-ask" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(qa.id, /^qa-/);
    assert.equal(qa.origin, "quick-ask");

    await runTool(runtime, manager.cancel([model.id, qa.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: qa.id, origin: "quick-ask" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes quick-ask sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "quick-ask" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("pi", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("pi", {
          ...task("another side question"),
          origin: "quick-ask",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    const settled = await runTool(
      runtime,
      manager.spawn("pi", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("timeout produces an actionable parent report", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", { ...task("Long task"), timeoutMs: 50 }),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const timedOut = manager.view.get(snap.id);
    assert.equal(timedOut?.status, "failed");
    assert.equal(timedOut?.report?.outcome, "timeout");
    assert.equal(timedOut?.report?.needsParentDecision, true);
    assert.equal(timedOut?.metrics.timeoutCount, 1);
    assert.match(timedOut?.report?.error?.recovery ?? "", /retry/i);
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
