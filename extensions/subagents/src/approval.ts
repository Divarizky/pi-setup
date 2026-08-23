/** Explicit approval state for build-subagent delivery operations. */

import type { SubagentMode } from "./domain.ts"

export const APPROVAL_OPERATIONS = [
  "review",
  "commit",
  "merge",
  "push",
  "pr",
  "delete-worktree",
] as const
export type ApprovalOperation = (typeof APPROVAL_OPERATIONS)[number]

export const DELIVERY_PREREQUISITES: Readonly<Record<ApprovalOperation, ReadonlyArray<ApprovalOperation>>> = {
  review: [],
  commit: ["review"],
  merge: ["commit"],
  push: ["commit"],
  pr: ["commit", "push"],
  "delete-worktree": [],
}

export type ApprovalStatus = "pending" | "approved" | "executing" | "rejected" | "consumed"

export interface ApprovalRequest {
  readonly id: string
  readonly jobId: string
  readonly operation: ApprovalOperation
  readonly status: ApprovalStatus
  readonly requestedAt: number
  readonly decidedAt?: number
  readonly decidedBy?: "human"
  readonly reason?: string
}

export class ApprovalGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalGateError"
  }
}

function approvalId(jobId: string, operation: ApprovalOperation) {
  return `approval:${jobId}:${operation}`
}

/**
 * In-memory fail-closed approval gate.
 *
 * Approval is explicit and one-shot: a request must be approved before it can
 * be consumed by a delivery operation, and consumed approval cannot be reused.
 * Persistence and delivery execution are deliberately separate concerns.
 */
export class ApprovalGate {
  private readonly requests = new Map<string, ApprovalRequest>()

  request(options: {
    readonly jobId: string
    readonly operation: ApprovalOperation
    readonly mode: SubagentMode
    readonly now?: number
  }): ApprovalRequest {
    if (options.mode !== "build") {
      throw new ApprovalGateError("Only build subagents may request delivery approval.")
    }
    const id = approvalId(options.jobId, options.operation)
    const existing = this.requests.get(id)
    if (existing) return existing

    const request: ApprovalRequest = {
      id,
      jobId: options.jobId,
      operation: options.operation,
      status: "pending",
      requestedAt: options.now ?? Date.now(),
    }
    this.requests.set(id, request)
    return request
  }

  get(id: string) {
    return this.requests.get(id)
  }

  list() {
    return [...this.requests.values()]
  }

  forgetJob(jobId: string) {
    for (const [id, request] of this.requests) {
      if (request.jobId === jobId) this.requests.delete(id)
    }
  }

  missingPrerequisites(jobId: string, operation: ApprovalOperation): ReadonlyArray<ApprovalOperation> {
    return DELIVERY_PREREQUISITES[operation].filter((required) =>
      this.requests.get(approvalId(jobId, required))?.status !== "consumed",
    )
  }

  restore(requests: ReadonlyArray<ApprovalRequest>) {
    for (const request of requests) {
      const expectedId = approvalId(request.jobId, request.operation)
      if (request.id !== expectedId) {
        throw new ApprovalGateError(`Malformed approval id: ${request.id}`)
      }
      if (this.requests.has(request.id)) {
        throw new ApprovalGateError(`Duplicate approval request: ${request.id}`)
      }
      this.requests.set(request.id, { ...request })
    }
  }

  approve(id: string, now = Date.now()): ApprovalRequest {
    return this.decide(id, "approved", now)
  }

  reject(id: string, reason: string, now = Date.now()): ApprovalRequest {
    if (!reason.trim()) throw new ApprovalGateError("Rejection reason is required.")
    const current = this.requirePending(id)
    const rejected: ApprovalRequest = {
      ...current,
      status: "rejected",
      decidedAt: now,
      decidedBy: "human",
      reason: reason.trim().slice(0, 4096),
    }
    this.requests.set(id, rejected)
    return rejected
  }

  begin(id: string): ApprovalRequest {
    const current = this.requireApproved(id)
    const executing: ApprovalRequest = { ...current, status: "executing" }
    this.requests.set(id, executing)
    return executing
  }

  complete(id: string): ApprovalRequest {
    const current = this.requests.get(id)
    if (!current) throw new ApprovalGateError(`Unknown approval request: ${id}`)
    if (current.status !== "executing") throw new ApprovalGateError(`Approval ${id} is ${current.status}; execution was not started.`)
    const consumed: ApprovalRequest = { ...current, status: "consumed" }
    this.requests.set(id, consumed)
    return consumed
  }

  fail(id: string): ApprovalRequest {
    const current = this.requests.get(id)
    if (!current) throw new ApprovalGateError(`Unknown approval request: ${id}`)
    if (current.status !== "executing") return current
    const approved: ApprovalRequest = { ...current, status: "approved" }
    this.requests.set(id, approved)
    return approved
  }

  consume(id: string): ApprovalRequest {
    const current = this.requireApproved(id)
    const consumed: ApprovalRequest = { ...current, status: "consumed" }
    this.requests.set(id, consumed)
    return consumed
  }

  private decide(id: string, status: "approved", now: number) {
    const current = this.requirePending(id)
    const missing = this.missingPrerequisites(current.jobId, current.operation)
    if (missing.length > 0) {
      throw new ApprovalGateError(`Approval ${id} is missing consumed prerequisite(s): ${missing.join(", ")}.`)
    }
    const approved: ApprovalRequest = {
      ...current,
      status,
      decidedAt: now,
      decidedBy: "human",
    }
    this.requests.set(id, approved)
    return approved
  }

  private requireApproved(id: string) {
    const current = this.requests.get(id)
    if (!current) throw new ApprovalGateError(`Unknown approval request: ${id}`)
    const missing = this.missingPrerequisites(current.jobId, current.operation)
    if (missing.length > 0) {
      throw new ApprovalGateError(`Approval ${id} is missing consumed prerequisite(s): ${missing.join(", ")}.`)
    }
    if (current.status !== "approved") {
      throw new ApprovalGateError(`Approval ${id} is ${current.status}; explicit approval is required before delivery.`)
    }
    return current
  }

  private requirePending(id: string) {
    const current = this.requests.get(id)
    if (!current) throw new ApprovalGateError(`Unknown approval request: ${id}`)
    if (current.status !== "pending") {
      throw new ApprovalGateError(`Approval ${id} is already ${current.status}.`)
    }
    return current
  }
}
