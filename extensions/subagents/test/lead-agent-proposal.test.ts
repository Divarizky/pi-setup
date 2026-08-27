import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LeadAgentProposalStore } from "../src/workflow/lead-agent-proposals.ts";

test("Lead Agent child proposals survive restart and require an explicit decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lead-agent-proposals-"));
  try {
    const store = new LeadAgentProposalStore(root);
    await store.restore();
    const proposal = await store.create({
      id: "proposal-auth-1",
      leadAgentId: "backend",
      title: "Investigate auth",
      prompt: "Inspect the auth flow and report the failure path.",
      mode: "scout",
      dependsOn: [],
      priority: 5,
    });
    assert.equal(proposal.status, "proposed");
    assert.equal(store.pending("backend").length, 1);

    const restored = new LeadAgentProposalStore(root);
    await restored.restore();
    const approved = await restored.approve(proposal.id);
    assert.equal(approved.status, "approved");
    assert.equal(restored.pending("backend").length, 0);
    assert.equal((await restored.approve(proposal.id)).status, "approved");
    assert.equal((await restored.dispatch(proposal.id)).status, "dispatched");
    await assert.rejects(restored.approve(proposal.id), /already settled/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Lead Agent cleanup removes undispatched proposals but preserves dispatched children", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lead-agent-proposals-"));
  try {
    const store = new LeadAgentProposalStore(root);
    const pending = await store.create({
      id: "proposal-cleanup-pending",
      leadAgentId: "lead-docs",
      title: "Pending child",
      prompt: "Inspect the docs.",
      mode: "scout",
      dependsOn: [],
      priority: 0,
    });
    const dispatched = await store.create({
      id: "proposal-cleanup-dispatched",
      leadAgentId: "lead-docs",
      title: "Dispatched child",
      prompt: "Inspect the API.",
      mode: "scout",
      dependsOn: [],
      priority: 0,
    });
    await store.approve(dispatched.id);
    await store.dispatch(dispatched.id);
    assert.deepEqual(await store.removeUndispatchedByLeadAgentId("lead-docs"), [
      pending.id,
    ]);
    assert.equal(store.get(pending.id), undefined);
    assert.equal(store.get(dispatched.id)?.status, "dispatched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Lead Agent proposal rejection is final and records a reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lead-agent-proposals-"));
  try {
    const store = new LeadAgentProposalStore(root);
    const proposal = await store.create({
      id: "proposal-auth-2",
      leadAgentId: "backend",
      title: "Change token policy",
      prompt: "Change production token policy.",
      mode: "build",
      dependsOn: [],
      priority: 0,
    });
    const rejected = await store.reject(
      proposal.id,
      "Parent chose a narrower task.",
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decisionReason, "Parent chose a narrower task.");
    await assert.rejects(
      store.reject(proposal.id, "another reason"),
      /already settled/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
