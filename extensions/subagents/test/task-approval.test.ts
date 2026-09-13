import { describe, expect, it } from "vitest";
import {
  captureCandidateApproval,
  validateCandidateApproval,
} from "../src/task-control/task-approval.js";
import type { TaskRecord } from "../src/task-control/task-state.js";

function candidateTask(): TaskRecord {
  return {
    id: "task-1",
    mode: "ship",
    policy: "ship",
    agentType: "build",
    objective: "Ship review",
    repositoryPath: "/repo",
    status: "candidate_ready",
    createdAt: 1,
    updatedAt: 2,
    baseSha: "b".repeat(40),
    targetBranch: "main",
    candidateBranch: "agent/task-1",
    candidateSha: "a".repeat(40),
  };
}

describe("candidate approval binding", () => {
  it("captures a user decision against immutable candidate and target state", () => {
    const approval = captureCandidateApproval(candidateTask(), "approved", 10);

    expect(approval).toEqual({
      actor: "user",
      decision: "approved",
      taskId: "task-1",
      candidateBranch: "agent/task-1",
      candidateSha: "a".repeat(40),
      targetBranch: "main",
      targetSha: "b".repeat(40),
      decidedAt: 10,
    });
  });

  it("rejects approval when candidate or target state changes", () => {
    const task = candidateTask();
    const approval = captureCandidateApproval(task, "approved", 10);

    expect(validateCandidateApproval({ ...task, candidateSha: "c".repeat(40) }, approval)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("candidate SHA"),
    });
    expect(validateCandidateApproval({ ...task, baseSha: "d".repeat(40) }, approval)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("target SHA"),
    });
    expect(validateCandidateApproval({ ...task, targetBranch: "release" }, approval)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("target branch"),
    });
  });

  it("does not create an approval for a task without a verified candidate", () => {
    expect(() => captureCandidateApproval({ ...candidateTask(), candidateSha: undefined }, "approved", 10))
      .toThrow(/candidate/i);
  });
});
