import assert from "node:assert/strict";
import test from "node:test";
import { resolveExecutionPolicy } from "../src/execution-policy.ts";
import { excludedToolsForMode } from "../src/backends/pi.ts";

test("child tool policy isolates Lead Agent tools by role", () => {
  const workerTools = excludedToolsForMode("build", "worker");
  const leadTools = excludedToolsForMode("build", "lead");
  assert.ok(workerTools.includes("subagent_lead_event"));
  assert.ok(workerTools.includes("subagent_lead_propose"));
  assert.ok(leadTools.includes("subagent_lead_approve"));
  assert.ok(!leadTools.includes("subagent_lead_event"));
  assert.ok(!leadTools.includes("subagent_lead_propose"));
});

test("scout defaults to a Pi read-only session without a worktree", () => {
  assert.deepEqual(resolveExecutionPolicy("scout"), {
    mode: "scout",
    backend: "pi",
    agent: "pi",
    requiresWorktree: false,
    readOnly: true,
  });
});

test("scout rejects a non-Pi backend", () => {
  assert.throws(
    () => resolveExecutionPolicy("scout", "orca"),
    /Scout only supports the Pi backend/i,
  );
});

test("build defaults to Orca with a Pi agent and a managed worktree", () => {
  assert.deepEqual(resolveExecutionPolicy("build"), {
    mode: "build",
    backend: "orca",
    agent: "pi",
    requiresWorktree: true,
    readOnly: false,
  });
});

test("build rejects a non-Orca backend", () => {
  assert.throws(
    () => resolveExecutionPolicy("build", "pi"),
    /Build requires the Orca backend/i,
  );
});
