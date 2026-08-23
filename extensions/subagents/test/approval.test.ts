import assert from "node:assert/strict"
import test from "node:test"
import { ApprovalGate, ApprovalGateError } from "../src/approval.ts"

test("approval is fail-closed and one-shot", () => {
  const gate = new ApprovalGate()
  const review = gate.request({
    jobId: "job-1",
    operation: "review",
    mode: "build",
    now: 100,
  })
  assert.equal(review.status, "pending")
  assert.throws(() => gate.consume(review.id), ApprovalGateError)
  gate.consume(gate.approve(review.id, 200).id)

  const unreviewed = gate.request({ jobId: "job-unreviewed", operation: "commit", mode: "build" })
  assert.throws(() => gate.approve(unreviewed.id, 250), /missing consumed prerequisite/i)
  assert.throws(() => gate.consume(unreviewed.id), ApprovalGateError)

  const request = gate.request({ jobId: "job-1", operation: "commit", mode: "build" })
  const approved = gate.approve(request.id, 300)
  assert.equal(approved.status, "approved")
  assert.equal(gate.consume(request.id).status, "consumed")
  assert.throws(() => gate.consume(request.id), /consumed/)
})

test("delivery approval records an executing intent before completion", () => {
  const gate = new ApprovalGate()
  const review = gate.request({ jobId: "job-intent", operation: "review", mode: "build" })
  gate.consume(gate.approve(review.id).id)
  const commit = gate.request({ jobId: "job-intent", operation: "commit", mode: "build" })
  gate.approve(commit.id)
  assert.equal(gate.begin(commit.id).status, "executing")
  assert.throws(() => gate.begin(commit.id), /executing/)
  assert.equal(gate.complete(commit.id).status, "consumed")
})

test("scout cannot request delivery approval", () => {
  const gate = new ApprovalGate()
  assert.throws(
    () => gate.request({ jobId: "job-2", operation: "merge", mode: "scout" }),
    /Only build subagents/,
  )
})

test("delivery prerequisites require a parent review before commit", () => {
  const gate = new ApprovalGate()
  assert.deepEqual(gate.missingPrerequisites("sa-1", "commit"), ["review"])
  const review = gate.request({ jobId: "sa-1", operation: "review", mode: "build" })
  gate.approve(review.id)
  gate.consume(review.id)
  assert.deepEqual(gate.missingPrerequisites("sa-1", "commit"), [])
  assert.deepEqual(gate.missingPrerequisites("sa-1", "push"), ["commit"])
  const commit = gate.request({ jobId: "sa-1", operation: "commit", mode: "build" })
  gate.approve(commit.id)
  gate.consume(commit.id)
  assert.deepEqual(gate.missingPrerequisites("sa-1", "push"), [])
  assert.deepEqual(gate.missingPrerequisites("sa-1", "pr"), ["push"])
})

test("rejection requires a reason and cannot be reused", () => {
  const gate = new ApprovalGate()
  const request = gate.request({ jobId: "job-3", operation: "push", mode: "build" })

  assert.throws(() => gate.reject(request.id, "   "), /reason is required/)
  assert.equal(gate.reject(request.id, "Tests were not run").status, "rejected")
  assert.throws(() => gate.approve(request.id), /already rejected/)
})
