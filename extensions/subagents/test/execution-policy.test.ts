import assert from "node:assert/strict";
import test from "node:test";
import { resolveExecutionPolicy } from "../src/execution-policy.ts";
import { excludedToolsForMode } from "../src/backends/pi.ts";
import { isProtectedShellCommand } from "../index.ts";
import { validateChildShellCommand } from "../src/shell-policy.ts";

test("child tool policy isolates Lead Agent tools by role", () => {
  const workerTools = excludedToolsForMode("build", "worker");
  const leadTools = excludedToolsForMode("build", "lead");
  const leadScoutTools = excludedToolsForMode("scout", "lead");
  assert.ok(workerTools.includes("subagent_lead_event"));
  assert.ok(workerTools.includes("subagent_detached_worktrees"));
  assert.ok(workerTools.includes("subagent_lead_propose"));
  assert.ok(leadTools.includes("subagent_lead_approve"));
  assert.ok(!leadTools.includes("subagent_spawn"));
  assert.ok(!leadScoutTools.includes("bash"));
  assert.ok(!leadScoutTools.includes("edit"));
  assert.ok(!leadScoutTools.includes("write"));
  assert.ok(!leadTools.includes("subagent_lead_event"));
  assert.ok(!leadTools.includes("subagent_lead_propose"));
});

test("shell approval guard catches risky Git options and wrappers", () => {
  assert.equal(
    isProtectedShellCommand("git -c user.name=x commit -am msg"),
    true,
  );
  assert.equal(
    isProtectedShellCommand("git -c remote.origin.url=x push"),
    true,
  );
  assert.equal(isProtectedShellCommand("git status && git commit -m x"), true);
  assert.equal(isProtectedShellCommand("git status"), false);
  assert.equal(isProtectedShellCommand("rm -fr build"), true);
  assert.equal(isProtectedShellCommand("Remove-Item -Recurse build"), true);
  assert.equal(isProtectedShellCommand("rmdir /s build"), true);
});

test("shell allowlist rejects executable paths and dangerous read options", () => {
  assert.equal(
    validateChildShellCommand("git branch --show-current").allowed,
    true,
  );
  assert.equal(
    validateChildShellCommand("git rev-parse --show-toplevel").allowed,
    true,
  );
  assert.equal(validateChildShellCommand("npm run lint").allowed, true);
  assert.equal(
    validateChildShellCommand("C:\\tools\\git.exe status").allowed,
    false,
  );
  assert.equal(
    validateChildShellCommand("git diff --output=result.txt").allowed,
    false,
  );
  assert.equal(validateChildShellCommand("rg --pre=cat secret").allowed, false);
  assert.equal(
    validateChildShellCommand("find . -exec whoami ;").allowed,
    false,
  );
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
