import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DetachedWorktreeStore } from "../src/detached-worktrees.ts";

test("detached worktrees remain discoverable after session metadata cleanup", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "subagents-detached-worktree-"),
  );
  try {
    const store = new DetachedWorktreeStore(root);
    await store.add({
      jobId: "build-1",
      title: "Build feature",
      backend: "orca",
      path: path.join(root, "worktree"),
      branch: "subagent/build-feature",
      repoRoot: root,
      nativeWorktreeId: "wt-1",
      detachedAt: 100,
    });
    const restored = new DetachedWorktreeStore(root);
    await restored.restore();
    assert.deepEqual(
      restored.list().map((item) => item.jobId),
      ["build-1"],
    );
    await restored.remove("build-1");
    assert.deepEqual(restored.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
