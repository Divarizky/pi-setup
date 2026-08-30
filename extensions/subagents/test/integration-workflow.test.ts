import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "../src/backend.ts";
import { ApprovalGate } from "../src/approval.ts";
import { makeStubBackend } from "../src/backends/stub.ts";
import {
  commitWorktree,
  mergeWorktree,
  validateWorktree,
} from "../src/delivery.ts";
import { SubagentManager, SubagentManagerLive } from "../src/manager.ts";
import { runTool } from "../src/runtime.ts";
import { LeadAgentStore } from "../src/agent-lead.ts";
import { LeadAgentInbox } from "../src/workflow/lead-agent-inbox.ts";
import { OrchestrationCoordinator } from "../src/workflow/coordinator.ts";
import { parseLeadAgentEvent } from "../src/workflow/orchestration.ts";
import { LeadAgentProposalStore } from "../src/workflow/lead-agent-proposals.ts";
import { TaskLedger } from "../src/workflow/task-ledger.ts";
import { WorkflowEventQueue } from "../src/workflow/wake-queue.ts";
import { runReadinessDoctor } from "../src/readiness.ts";
import { provisionLeadProjects } from "../src/lead-home.ts";
import { createSubagentWorktree } from "../src/worktree.ts";

const execFile = promisify(execFileCallback);

function createStubRuntime() {
  const registry = Layer.sync(BackendRegistry, () => {
    const backend = makeStubBackend({
      backend: "pi",
      defaultModelLabel: "pi/test",
      contextWindow: 128_000,
      toolName: "read",
      cadenceMs: 5,
    });
    return new Map([[backend.name, backend]]);
  });
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}

async function git(cwd: string, args: string[]) {
  return execFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

test("integration: proposal approval spawn and worker_done", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-integration-workflow-"),
  );
  const source = path.join(root, "source");
  const home = path.join(root, "lead-home");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "README.md"), "demo\n", "utf8");
  await execFile("git", ["init", source], {
    encoding: "utf8",
    windowsHide: true,
  });
  const runtime = createStubRuntime();
  try {
    assert.equal((await runReadinessDoctor(home, true)).ready, true);
    const projects = await provisionLeadProjects(home, [
      { projectId: "demo", source },
    ]);
    const leadStore = new LeadAgentStore(root);
    const inbox = new LeadAgentInbox(root);
    const proposals = new LeadAgentProposalStore(root);
    const ledger = new TaskLedger(root);
    const workflow = new WorkflowEventQueue(root);
    let workerDone = false;
    const coordinator = new OrchestrationCoordinator(ledger, async (event) => {
      if (event.type === "proposal") {
        const proposal = await proposals.create({
          id: event.proposalId,
          leadAgentId: event.leadAgentId,
          title: event.title,
          prompt: event.prompt,
          mode: event.mode,
          workingDir: event.workingDir,
          dependsOn: event.dependsOn,
          priority: event.priority,
        });
        await ledger.ensure({
          id: proposal.id,
          title: proposal.title,
          mode: proposal.mode,
          role: "worker",
          dependsOn: proposal.dependsOn,
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
      } else if (event.type === "worker_done") {
        workerDone = true;
      }
    });
    const manager = await runtime.runPromise(SubagentManager);
    const lead = await runTool(
      runtime,
      manager.spawn("pi", {
        jobId: "lead-integration",
        prompt: "Coordinate a README review.",
        title: "Docs Lead",
        cwd: source,
        mode: "scout",
        role: "lead",
        leadAgentId: "docs-lead",
        sessionDir: home,
        parent: { parentCwd: source, projectTrusted: true },
      }),
    );
    await leadStore.create({
      leadAgentId: "docs-lead",
      jobId: lead.id,
      title: "Docs Lead",
      backend: "pi",
      mode: "scout",
      cwd: source,
      homePath: home,
    });
    await runTool(runtime, manager.waitFor([lead.id]));

    const proposalEvent = parseLeadAgentEvent({
      eventId: "proposal-integration",
      type: "proposal",
      actorId: "docs-lead",
      leadAgentId: "docs-lead",
      at: Date.now(),
      proposalId: "review-readme",
      title: "Review README",
      prompt: "Inspect README for clarity.",
      workingDir: "projects/demo",
      mode: "scout",
      dependsOn: [],
      priority: 1,
    });
    await inbox.enqueue(proposalEvent);
    await inbox.drain(async (event) => {
      await coordinator.emit(event);
    });
    assert.equal(ledger.get("review-readme")?.status, "queued");
    assert.equal(proposals.get("review-readme")?.status, "proposed");

    // Replaying proposal registration after an execution starts must preserve
    // the active task, rather than attempting the invalid working -> queued transition.
    await ledger.status("review-readme", "working");
    await ledger.ensure({
      id: "review-readme",
      title: "Review README",
      mode: "scout",
      role: "worker",
      dependsOn: [],
      priority: 1,
      requiresWorktree: false,
      leadAgentId: "docs-lead",
    });
    assert.equal(ledger.get("review-readme")?.status, "working");

    await proposals.approve("review-readme");
    const approved = await proposals.dispatch("review-readme");
    assert.equal(approved.status, "dispatched");
    const worker = await runTool(
      runtime,
      manager.spawn("pi", {
        jobId: "worker-integration",
        prompt: approved.prompt,
        title: approved.title,
        cwd: projects[0].clonePath,
        mode: "scout",
        role: "worker",
        leadAgentId: "docs-lead",
        sessionDir: home,
        parent: { parentCwd: source, projectTrusted: true },
      }),
    );
    await runTool(runtime, manager.waitFor([worker.id]));
    assert.equal(manager.view.get(worker.id)?.status, "done");

    await inbox.enqueue(
      parseLeadAgentEvent({
        eventId: "worker-done-integration",
        type: "worker_done",
        actorId: "docs-lead",
        leadAgentId: "docs-lead",
        taskId: approved.id,
        at: Date.now(),
        summary: "README review completed.",
      }),
    );
    await inbox.drain(async (event) => {
      await coordinator.emit(event);
    });
    assert.equal(workerDone, true);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("integration: local delivery executes only after ordered approvals", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-integration-delivery-"),
  );
  const repo = path.join(root, "repo");
  const workspace = path.join(root, "workspace");
  const jobId = "local-delivery";
  const runtime = createStubRuntime();
  try {
    await execFile("git", ["init", repo], {
      encoding: "utf8",
      windowsHide: true,
    });
    await writeFile(path.join(repo, "README.md"), "source\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, [
      "-c",
      "user.name=Pi Test",
      "-c",
      "user.email=pi-test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    const worktree = await createSubagentWorktree({
      sourceDir: repo,
      workspaceRoot: workspace,
      jobId,
    });
    await writeFile(
      path.join(worktree.path, "change.txt"),
      "delivered\n",
      "utf8",
    );
    const gate = new ApprovalGate();
    const commit = gate.request({ jobId, operation: "commit", mode: "build" });
    assert.throws(
      () => gate.approve(commit.id),
      /missing consumed prerequisite/i,
    );

    const review = gate.request({ jobId, operation: "review", mode: "build" });
    assert.throws(() => gate.consume(review.id), /explicit approval/i);
    gate.approve(review.id);
    gate.begin(review.id);
    const validation = await validateWorktree(worktree);
    assert.deepEqual(validation.changedFiles, ["change.txt"]);
    gate.complete(review.id);

    gate.approve(commit.id);
    gate.begin(commit.id);
    await commitWorktree(worktree, "Add local change");
    gate.complete(commit.id);

    const merge = gate.request({ jobId, operation: "merge", mode: "build" });
    gate.approve(merge.id);
    gate.begin(merge.id);
    await mergeWorktree(worktree, repo, "Merge local change");
    gate.complete(merge.id);

    assert.equal(gate.get(review.id)?.status, "consumed");
    assert.equal(gate.get(commit.id)?.status, "consumed");
    assert.equal(gate.get(merge.id)?.status, "consumed");
    assert.equal(
      (await readFile(path.join(repo, "change.txt"), "utf8")).trim(),
      "delivered",
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
