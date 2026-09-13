import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../src/task-control/task-state.js";
import { buildTaskViews, formatTaskView, headlessIntegrationError } from "../src/task-control/task-view.js";

function candidateTask(id: string, updatedAt: number): TaskRecord {
  return {
    id,
    mode: "ship",
    policy: "ship",
    agentType: "build",
    objective: "Implement durable review",
    repositoryPath: "/repo",
    status: "candidate_ready",
    createdAt: 1,
    updatedAt,
    baseSha: "b".repeat(40),
    targetBranch: "main",
    candidateBranch: "pi-agent-task",
    candidateSha: "a".repeat(40),
    changedFiles: ["src/index.ts"],
    validationEvidence: [{
      command: "npm test",
      exitCode: 0,
      timedOut: false,
      stdout: "Tests passed",
      stderr: "",
      startedAt: 2,
      finishedAt: 3,
    }],
  };
}

describe("Agent Control task view", () => {
  it("maps durable candidate metadata independently of AgentRecord", () => {
    const views = buildTaskViews({ version: 1, tasks: { candidate: candidateTask("candidate", 20) } });

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      taskId: "candidate",
      objective: "Implement durable review",
      targetBranch: "main",
      targetSha: "b".repeat(40),
      processStatus: "finished",
      validationStatus: "passed",
      candidateStatus: "ready",
      deliveryStatus: "pending_approval",
      candidateSha: "a".repeat(40),
      changedFiles: ["src/index.ts"],
      hasCandidate: true,
    });
  });

  it("formats target, immutable SHA, changed files, and validation evidence", () => {
    const view = buildTaskViews({ version: 1, tasks: { candidate: candidateTask("candidate", 20) } })[0];
    const output = formatTaskView(view);

    expect(output).toContain("Process status: finished");
    expect(output).toContain("Validation status: passed");
    expect(output).toContain("Candidate status: ready");
    expect(output).toContain("Delivery status: pending_approval");
    expect(output).toContain("Objective: Implement durable review");
    expect(output).toContain(`Candidate SHA: ${"a".repeat(40)}`);
    expect(output).toContain(`Target SHA: ${"b".repeat(12)}…`);
    expect(output).toContain("Target branch: main");
    expect(output).toContain("Changed files: src/index.ts");
    expect(output).toContain("npm test — exit 0");
  });

  it("redacts secrets in task errors", () => {
    const task = { ...candidateTask("candidate", 20), error: "token=super-secret-value" };
    const output = formatTaskView(buildTaskViews({ version: 1, tasks: { candidate: task } })[0]);

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("super-secret-value");
  });

  it("rejects integration from headless runtime without a Git mutation", () => {
    expect(headlessIntegrationError(false)).toContain("headless");
    expect(headlessIntegrationError(true)).toBeUndefined();
  });
});
