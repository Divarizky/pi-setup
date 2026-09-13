// README publishes concrete default values. Keep these checks isolated from
// module state changed by the rest of the suite.
//
// The defaults live in module-level `let`s that the settings appliers overwrite
// at boot, so reading them after any other suite has run tells you nothing.
// `vi.resetModules()` + a dynamic import gives a genuinely fresh module, which
// is why this lives in its own file: resetModules is file-wide and hostile to
// suites that hold module references across tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("documented defaults", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // src/agent-runner.js pulls in the whole pi-coding-agent graph, and
  // `server.deps.inline` means resetModules re-transforms all of it — several
  // seconds under a loaded full run, versus instant in isolation. Give every
  // test in this file a generous timeout rather than masking the cost with
  // retries.
  const HEAVY_REIMPORT_MS = 120_000;
  vi.setConfig({ testTimeout: HEAVY_REIMPORT_MS });

  it("defaults max turns to 40", async () => {
    const { getDefaultMaxTurns } = await import("../src/agent-runner.js");
    expect(getDefaultMaxTurns()).toBe(40);
  }, HEAVY_REIMPORT_MS);

  it("nested subagent depth defaults to 4", async () => {
    const { getMaxSubagentDepth } = await import("../src/nested-tools.js");
    expect(getMaxSubagentDepth()).toBe(4);
  });

  // Raised from 4 when top-level spawns started defaulting to background:
  // foreground bypasses the pool entirely, so a limit tuned for opt-in
  // background would now queue the tail of ordinary parallel fan-outs.
  it("background concurrency defaults to 10", async () => {
    const { AgentManager } = await import("../src/core/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrent()).toBe(10);
    } finally {
      manager.dispose();
    }
  });

  it("defaults foreground concurrency to 4", async () => {
    const { AgentManager } = await import("../src/core/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrentForeground()).toBe(4);
    } finally {
      manager.dispose();
    }
  });

  it("top-level spawns default to background, nested spawns to foreground", async () => {
    const { resolveAgentInvocationConfig } = await import("../src/invocation-config.js");
    // The setting's default (true) is what index.ts passes for top-level calls.
    expect(resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: true }).runInBackground).toBe(true);
    // nested-tools.ts passes false unconditionally.
    expect(resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: false }).runInBackground).toBe(false);
    // An explicit param still wins over either default.
    expect(resolveAgentInvocationConfig(undefined, { run_in_background: false }, { defaultRunInBackground: true }).runInBackground).toBe(false);
    expect(resolveAgentInvocationConfig(undefined, { run_in_background: true }, { defaultRunInBackground: false }).runInBackground).toBe(true);
  });
});
