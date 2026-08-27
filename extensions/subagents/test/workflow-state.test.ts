import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkflowEvent,
  createWorkflowTask,
  type WorkflowEvent,
} from "../src/workflow/state.ts";

test("workflow tasks start queued with explicit worktree policy", () => {
  const task = createWorkflowTask({
    id: "build-auth",
    title: "Fix auth",
    mode: "build",
    role: "worker",
    dependsOn: [],
    priority: 10,
    requiresWorktree: true,
    now: 100,
  });

  assert.deepEqual(task, {
    id: "build-auth",
    title: "Fix auth",
    mode: "build",
    role: "worker",
    dependsOn: [],
    priority: 10,
    requiresWorktree: true,
    status: "queued",
    createdAt: 100,
    updatedAt: 100,
  });
});

test("workflow events fold through blocked recovery to done", () => {
  let task = createWorkflowTask({
    id: "scout-auth",
    title: "Investigate auth",
    mode: "scout",
    role: "worker",
    dependsOn: [],
    priority: 0,
    requiresWorktree: false,
    now: 100,
  });
  const events: WorkflowEvent[] = [
    { type: "status", status: "working", at: 110 },
    {
      type: "status",
      status: "blocked",
      message: "Needs clarification",
      at: 120,
    },
    { type: "status", status: "working", at: 130 },
    { type: "status", status: "done", at: 140 },
  ];

  for (const event of events) task = applyWorkflowEvent(task, event);

  assert.equal(task.status, "done");
  assert.equal(task.updatedAt, 140);
  assert.equal(task.blockedReason, undefined);
});

test("workflow resumes a decision task before completing it", () => {
  let task = createWorkflowTask({
    id: "needs-decision-task",
    title: "Needs decision",
    mode: "build",
    role: "worker",
    dependsOn: [],
    priority: 0,
    requiresWorktree: true,
    now: 100,
  });
  task = applyWorkflowEvent(task, {
    type: "status",
    status: "working",
    at: 110,
  });
  task = applyWorkflowEvent(task, {
    type: "status",
    status: "needs-decision",
    at: 120,
  });
  task = applyWorkflowEvent(task, {
    type: "status",
    status: "working",
    message: "Parent decision received.",
    at: 130,
  });
  task = applyWorkflowEvent(task, { type: "status", status: "done", at: 140 });

  assert.equal(task.status, "done");
  assert.equal(task.errorText, undefined);
});

test("workflow rejects invalid transitions instead of reviving a settled task", () => {
  const task = createWorkflowTask({
    id: "finished",
    title: "Finished task",
    mode: "build",
    role: "worker",
    dependsOn: [],
    priority: 0,
    requiresWorktree: true,
    now: 100,
  });
  const working = applyWorkflowEvent(task, {
    type: "status",
    status: "working",
    at: 105,
  });
  const done = applyWorkflowEvent(working, {
    type: "status",
    status: "done",
    at: 110,
  });

  assert.throws(
    () =>
      applyWorkflowEvent(done, { type: "status", status: "working", at: 120 }),
    /Invalid workflow transition/i,
  );
});
