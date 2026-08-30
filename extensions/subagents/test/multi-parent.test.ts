import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createParentStateRoot,
  runWithParentStateRoot,
  activeParentStateRoot,
} from "../src/parent-state.ts";
import { GlobalCapacityPool } from "../src/capacity-pool.ts";
import { acquireStateLease } from "../src/state-lock.ts";

test("different parent namespaces can hold state leases concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-parent-locks-"));
  try {
    const first = await acquireStateLease(path.join(root, "parent-a"));
    const second = await acquireStateLease(path.join(root, "parent-b"));
    await second.release();
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent state roots are stable per session and isolated across sessions", async () => {
  const agentDir = await mkdtemp(
    path.join(os.tmpdir(), "subagents-parent-state-"),
  );
  try {
    const first = createParentStateRoot(agentDir, "session-a");
    const firstAgain = createParentStateRoot(agentDir, "session-a");
    const second = createParentStateRoot(agentDir, "session-b");
    assert.equal(first, firstAgain);
    assert.notEqual(first, second);
    assert.match(first, /parents[\\/][a-f0-9]{24}$/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("parent state context is scoped and restored", async () => {
  assert.equal(activeParentStateRoot(), undefined);
  const result = await runWithParentStateRoot("parent-a", async () => {
    assert.equal(activeParentStateRoot(), "parent-a");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(activeParentStateRoot(), undefined);
});

test("global capacity pool enforces four slots across parent owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-capacity-"));
  try {
    const first = new GlobalCapacityPool(root, 4);
    const second = new GlobalCapacityPool(root, 4);
    const leases = [];
    for (let i = 0; i < 2; i++) {
      const lease = await first.tryAcquire(`job-${i}`, `parent-${i}`);
      assert.ok(lease);
      leases.push(lease);
    }
    for (let i = 2; i < 4; i++) {
      const lease = await second.tryAcquire(`job-${i}`, `parent-${i}`);
      assert.ok(lease);
      leases.push(lease);
    }
    assert.equal(await first.tryAcquire("job-4", "parent-4"), undefined);
    await leases[0].release();
    const replacement = await second.tryAcquire("job-4", "parent-4");
    assert.ok(replacement);
    await replacement.release();
    for (const lease of leases.slice(1)) await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity pool reclaims a dead owner slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-capacity-"));
  try {
    await writeFile(
      path.join(root, "slot-0.lock"),
      JSON.stringify({
        jobId: "dead-job",
        parentId: "dead-parent",
        pid: Number.MAX_SAFE_INTEGER,
        token: "dead",
        createdAt: 0,
      }),
    );
    const pool = new GlobalCapacityPool(root, 1);
    const lease = await pool.tryAcquire("live-job", "live-parent");
    assert.ok(lease);
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity release is token-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-capacity-"));
  try {
    const pool = new GlobalCapacityPool(root, 1);
    const lease = await pool.tryAcquire("job-a", "parent-a");
    assert.ok(lease);
    await pool.release("job-a", "wrong-token");
    assert.equal(await pool.tryAcquire("job-b", "parent-b"), undefined);
    await lease.release();
    assert.ok(await pool.tryAcquire("job-b", "parent-b"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
