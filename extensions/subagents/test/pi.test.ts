/**
 * Live pi backend test — requires a real pi environment and API credentials.
 *
 * Run with: node --test test/pi.test.ts
 *
 * What it verifies:
 * - A real createAgentSession() can be started and settles
 * - Events are translated correctly (RunStarted, AssistantDelta, RunSettled)
 * - subagent_wait resolves with real model output
 * - cancel sets status to failed/interrupted
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "../src/backend.ts";
import { piBackend } from "../src/backends/pi.ts";
import type { BackendName } from "../src/domain.ts";
import { SubagentManager, SubagentManagerLive } from "../src/manager.ts";
import { runTool } from "../src/runtime.ts";

const PiOnlyRegistryLive = Layer.sync(BackendRegistry, () => {
  return new Map<BackendName, typeof piBackend>([["pi", piBackend]]);
});

const createRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(PiOnlyRegistryLive)),
  );

const TIMEOUT_MS = 120_000;

test(
  "pi: real session completes with non-empty output",
  { timeout: TIMEOUT_MS },
  async () => {
    const runtime = createRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const snap = await runTool(
        runtime,
        manager.spawn("pi", {
          prompt:
            "Reply with exactly one word: 'acknowledged'. No other text, no punctuation, no explanation.",
          title: "pi-live-test",
          cwd: process.cwd(),
          parent: { parentCwd: process.cwd(), projectTrusted: false },
        }),
      );
      assert.equal(snap.status, "running");
      assert.equal(snap.backend, "pi");
      assert.ok(snap.meta.sessionFilePath, "sessionFilePath should be set");

      await runTool(runtime, manager.waitFor([snap.id]));
      const done = manager.view.get(snap.id);
      assert.ok(done, "snapshot must exist after waitFor");
      assert.equal(
        done.status,
        "done",
        `status should be done, got: ${done.status} (${done.errorText})`,
      );
      assert.ok(
        done.finalText.trim().length > 0,
        `finalText must not be empty, got: "${done.finalText}"`,
      );
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "pi: cancel settles a running session as failed",
  { timeout: TIMEOUT_MS },
  async () => {
    const runtime = createRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const snap = await runTool(
        runtime,
        manager.spawn("pi", {
          prompt: "Count to 1000 slowly, one number per line.",
          title: "pi-cancel-test",
          cwd: process.cwd(),
          parent: { parentCwd: process.cwd(), projectTrusted: false },
        }),
      );
      assert.equal(snap.status, "running");

      const report = await runTool(runtime, manager.cancel([snap.id]));
      assert.equal(report[0]?.cancelled, true);

      const after = manager.view.get(snap.id);
      assert.equal(after?.status, "failed");
      assert.equal(after?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "pi: running events fire before settle (smoke check)",
  { timeout: TIMEOUT_MS },
  async () => {
    const runtime = createRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const snap = await runTool(
        runtime,
        manager.spawn("pi", {
          prompt:
            "Write three words separated by spaces only: apple banana cherry",
          title: "pi-events-test",
          cwd: process.cwd(),
          parent: { parentCwd: process.cwd(), projectTrusted: false },
        }),
      );
      await runTool(runtime, manager.waitFor([snap.id]));
      const done = manager.view.get(snap.id);
      assert.ok(done, "snapshot must exist after waitFor");
      assert.ok(
        done.turns != null && done.turns >= 1,
        `at least 1 turn; got ${done.turns}`,
      );
      assert.ok(
        done.transcript.some((item) => item.kind === "assistant"),
        "transcript should contain assistant message",
      );
    } finally {
      await runtime.dispose();
    }
  },
);
