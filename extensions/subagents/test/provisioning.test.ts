import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProvisioningStore } from "../src/provisioning.ts";

test("provisioning intent survives restart and can be completed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-provisioning-"));
  try {
    const store = new ProvisioningStore(root);
    await store.begin({
      jobId: "lead-docs-job",
      backend: "orca",
      mode: "build",
      title: "Documentation Lead",
      sourceCwd: process.cwd(),
      branchName: "chore/documentation-lead",
    });
    const restored = new ProvisioningStore(root);
    await restored.restore();
    assert.equal(restored.get("lead-docs-job")?.title, "Documentation Lead");
    await restored.update("lead-docs-job", {
      worktree: {
        jobId: "lead-docs-job",
        repoRoot: process.cwd(),
        path: path.join(root, "worktree"),
        branch: "chore/documentation-lead",
      },
      nativeWorktreeId: "wt-1",
    });
    assert.equal(restored.get("lead-docs-job")?.nativeWorktreeId, "wt-1");
    await restored.remove("lead-docs-job");
    assert.equal(restored.list().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
