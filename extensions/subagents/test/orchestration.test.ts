import assert from "node:assert/strict"
import test from "node:test"
import { parseLeadAgentEvent } from "../src/workflow/orchestration.ts"

test("Lead Agent protocol validates proposals and operational events", () => {
  const proposal = parseLeadAgentEvent({
    eventId: "event-1",
    type: "proposal",
    actorId: "lead-docs",
    leadAgentId: "docs",
    taskId: "task-1",
    at: 100,
    proposalId: "proposal-1",
    title: "Inspect docs",
    prompt: "Review the documentation links.",
    mode: "scout",
    dependsOn: ["task-0", "task-0"],
    priority: 5,
  })
  assert.equal(proposal.type, "proposal")
  assert.deepEqual(proposal.dependsOn, ["task-0"])

  const ask = parseLeadAgentEvent({
    eventId: "event-2",
    type: "ask",
    actorId: "lead-docs",
    leadAgentId: "docs",
    correlationId: "question-1",
    at: 101,
    question: "Should the API remain backwards compatible?",
  })
  assert.equal(ask.type, "ask")
  assert.throws(() => parseLeadAgentEvent({ ...ask, eventId: "bad id" }), /Invalid Lead Agent event event id/)
})
