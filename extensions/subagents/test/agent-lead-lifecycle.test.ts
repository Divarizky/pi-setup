import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "../src/backend.ts";
import { makeStubBackend } from "../src/backends/stub.ts";
import { SubagentManager, SubagentManagerLive } from "../src/manager.ts";
import { LeadAgentStore } from "../src/agent-lead.ts";
import { LeadAgentProposalStore } from "../src/workflow/lead-agent-proposals.ts";
import { TaskLedger } from "../src/workflow/task-ledger.ts";
import { WorkflowEventQueue } from "../src/workflow/wake-queue.ts";
import {
  resolveManagedLeadHome,
  resolveManagedSessionFile,
} from "../src/session-path.ts";
import { runTool } from "../src/runtime.ts";
import type { BackendName, SpawnTask } from "../src/domain.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backend: SubagentBackend = makeStubBackend({
    backend: "pi",
    defaultModelLabel: "pi/test",
    contextWindow: 128_000,
    toolName: "read",
    cadenceMs: 5,
  });
  return new Map<BackendName, SubagentBackend>([[backend.name, backend]]);
});

const createRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

test("Agent Lead session reopen guard rejects unsafe paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-agent-lead-session-"));
  const managed = path.join(root, "leads");
  const outside = path.join(root, "outside");
  const directory = path.join(managed, "directory");
  await mkdir(directory, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    const outsideFile = path.join(outside, "session.jsonl");
    await writeFile(outsideFile, "outside\n", "utf8");
    await assert.rejects(
      resolveManagedSessionFile(outsideFile, [managed]),
      /outside managed session directories/,
    );
    await assert.rejects(
      resolveManagedSessionFile(directory, [managed]),
      /not a regular file/,
    );
    assert.equal(
      await resolveManagedSessionFile(path.join(managed, "missing.jsonl"), [
        managed,
      ]),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent Lead lifecycle creates, resumes, and cleans all durable state", async () => {
  const lifecycleRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-agent-lead-lifecycle-"),
  );
  const home = path.join(lifecycleRoot, "leads", "docs");
  const outside = path.join(lifecycleRoot, "outside");
  await mkdir(home, { recursive: true });
  await mkdir(outside, { recursive: true });
  const sessionFile = path.join(home, "session.jsonl");
  await writeFile(sessionFile, "session\n", "utf8");
  await writeFile(path.join(outside, "session.jsonl"), "outside\n", "utf8");
  const runtime = createRuntime();
  const leadStore = new LeadAgentStore(lifecycleRoot);
  const proposalStore = new LeadAgentProposalStore(lifecycleRoot);
  const ledger = new TaskLedger(lifecycleRoot);
  const workflow = new WorkflowEventQueue(lifecycleRoot);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const task: SpawnTask = {
      jobId: "lead-docs-job",
      prompt: "Coordinate documentation work.",
      title: "Documentation",
      cwd: process.cwd(),
      mode: "scout",
      role: "lead",
      leadAgentId: "docs",
      sessionDir: home,
      parent: { parentCwd: process.cwd(), projectTrusted: false },
    };
    const snap = await runTool(runtime, manager.spawn("pi", task));
    await leadStore.create({
      leadAgentId: "docs",
      jobId: snap.id,
      title: "Documentation",
      backend: "pi",
      mode: "scout",
      cwd: snap.cwd,
      homePath: home,
      sessionFilePath: snap.meta.sessionFilePath,
    });

    const proposal = await proposalStore.create({
      id: "proposal-docs",
      leadAgentId: "docs",
      title: "Inspect docs",
      prompt: "Inspect documentation consistency.",
      mode: "scout",
      dependsOn: [],
      priority: 1,
    });
    await ledger.ensure({
      id: proposal.id,
      title: proposal.title,
      mode: proposal.mode,
      role: "worker",
      dependsOn: [],
      priority: proposal.priority,
      requiresWorktree: false,
      leadAgentId: proposal.leadAgentId,
    });
    await workflow.publish(proposal.id, {
      type: "status",
      status: "queued",
      at: Date.now(),
      generation: 1,
    });

    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "done");
    await runTool(runtime, manager.send(snap.id, "Continue the coordination."));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "done");
    assert.equal(
      await resolveManagedLeadHome(home, path.join(lifecycleRoot, "leads")),
      await realpath(home),
    );
    assert.equal(
      await resolveManagedSessionFile(sessionFile, [
        path.join(lifecycleRoot, "leads"),
      ]),
      await realpath(sessionFile),
    );
    await rm(sessionFile);
    assert.equal(
      await resolveManagedSessionFile(sessionFile, [
        path.join(lifecycleRoot, "leads"),
      ]),
      undefined,
    );
    await assert.rejects(
      resolveManagedSessionFile(path.join(outside, "session.jsonl"), [
        path.join(lifecycleRoot, "leads"),
      ]),
      /outside managed session directories/,
    );

    const removed = await proposalStore.removeUndispatchedByLeadAgentId("docs");
    assert.deepEqual(removed, ["proposal-docs"]);
    await workflow.removeTask("proposal-docs");
    await ledger.remove("proposal-docs");
    await runTool(runtime, manager.closeSession(snap.id));
    await runTool(runtime, manager.forget(snap.id));
    await rm(home, { recursive: true, force: true });
    await leadStore.removeByJobId(snap.id);

    assert.equal(leadStore.get("docs"), undefined);
    assert.deepEqual(proposalStore.list("docs"), []);
    assert.equal(ledger.get("proposal-docs"), undefined);
    assert.deepEqual(workflow.pending(), []);
    assert.equal(manager.view.get(snap.id), undefined);
    assert.equal(
      await resolveManagedLeadHome(home, path.join(lifecycleRoot, "leads")),
      undefined,
    );
  } finally {
    await runtime.dispose();
    await rm(lifecycleRoot, { recursive: true, force: true });
  }
});
