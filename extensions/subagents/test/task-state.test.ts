import { describe, expect, it } from "vitest";
import { canTransitionTask, type TaskRecord, transitionTask } from "../src/task-control/task-state.js";

function task(status: TaskRecord["status"] = "preparing"): TaskRecord {
  return {
    id: "task-1",
    mode: "scout",
    policy: "scout",
    agentType: "explore",
    objective: "Inspect the repository",
    repositoryPath: "/repo",
    status,
    createdAt: 100,
    updatedAt: 100,
  };
}

describe("Agent Control task state machine", () => {
  it("allows a scout to move from preparing to running to completed", () => {
    const running = transitionTask(task(), "running", "agent started", 200);
    const completed = transitionTask(running, "completed", "scout finished", 300);

    expect(running.status).toBe("running");
    expect(completed).toMatchObject({ status: "completed", updatedAt: 300 });
  });

  it("rejects a transition that skips the running state", () => {
    expect(canTransitionTask("preparing", "completed")).toBe(false);
    expect(() => transitionTask(task(), "completed", "invalid shortcut", 200)).toThrow(
      'Invalid task transition: "preparing" -> "completed".',
    );
  });

  it("records a committed integration whose durable state failed separately", () => {
    expect(canTransitionTask("integrating", "integrated_unrecorded")).toBe(true);
    expect(transitionTask(task("integrating"), "integrated_unrecorded", "state update failed", 200).status).toBe("integrated_unrecorded");
  });

  it("treats unknown statuses as non-transitions instead of throwing", () => {
    expect(canTransitionTask("integrating", "bogus" as never)).toBe(false);
  });

  it("lets a restarted interrupted task record its terminal outcome", () => {
    expect(canTransitionTask("interrupted", "failed")).toBe(true);
    expect(canTransitionTask("interrupted", "validation_failed")).toBe(true);
    expect(canTransitionTask("interrupted", "completed_no_changes")).toBe(true);
    expect(transitionTask(task("interrupted"), "failed", "agent errored", 200).status).toBe("failed");
  });

  it("treats terminal states as immutable", () => {
    expect(canTransitionTask("completed", "running")).toBe(false);
    expect(() => transitionTask(task("completed"), "running", "restart", 200)).toThrow(
      'Invalid task transition: "completed" -> "running".',
    );
  });
});
