import type { SubagentMode } from "../domain.ts"

export type WorkflowTaskRole = "worker" | "subagent-lead"

export const WORKFLOW_STATUSES = [
  "queued",
  "working",
  "blocked",
  "needs-decision",
  "paused",
  "done",
  "failed",
  "unknown",
] as const

export type WorkflowTaskStatus = (typeof WORKFLOW_STATUSES)[number]

export interface WorkflowTask {
  readonly id: string
  readonly title: string
  readonly mode: SubagentMode
  readonly role: WorkflowTaskRole
  readonly dependsOn: ReadonlyArray<string>
  readonly priority: number
  readonly requiresWorktree: boolean
  readonly status: WorkflowTaskStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly blockedReason?: string
  readonly errorText?: string
}

export type WorkflowEvent = {
  readonly type: "status"
  readonly status: WorkflowTaskStatus
  readonly at: number
  /** Retry/restart incarnation; prevents a later run resurrecting an old one. */
  readonly generation?: number
  readonly message?: string
}

export interface WorkflowTaskInput {
  readonly id: string
  readonly title: string
  readonly mode: SubagentMode
  readonly role: WorkflowTaskRole
  readonly dependsOn: ReadonlyArray<string>
  readonly priority: number
  readonly requiresWorktree: boolean
  readonly now?: number
}

const ALLOWED_TRANSITIONS: Readonly<Record<WorkflowTaskStatus, ReadonlyArray<WorkflowTaskStatus>>> = {
  queued: ["queued", "working", "blocked", "failed", "unknown"],
  working: ["blocked", "needs-decision", "paused", "done", "failed", "unknown"],
  blocked: ["working", "failed", "unknown"],
  "needs-decision": ["working", "blocked", "failed", "unknown"],
  paused: ["working", "failed", "unknown"],
  done: [],
  failed: [],
  unknown: ["working", "failed", "unknown"],
}

function boundedMessage(message: string | undefined) {
  return message === undefined ? undefined : message.slice(0, 4_096)
}

export function createWorkflowTask(input: WorkflowTaskInput): WorkflowTask {
  const now = input.now ?? Date.now()
  return {
    id: input.id,
    title: input.title,
    mode: input.mode,
    role: input.role,
    dependsOn: [...new Set(input.dependsOn)],
    priority: Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0,
    requiresWorktree: input.requiresWorktree,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  }
}

export function validateWorkflowTransition(from: WorkflowTaskStatus, to: WorkflowTaskStatus) {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}.`)
  }
}

export function applyWorkflowEvent(task: WorkflowTask, event: WorkflowEvent): WorkflowTask {
  validateWorkflowTransition(task.status, event.status)
  const message = boundedMessage(event.message)
  return {
    ...task,
    status: event.status,
    updatedAt: event.at,
    ...(event.status === "blocked"
      ? { blockedReason: message ?? "Task is blocked." }
      : { blockedReason: undefined }),
    ...(event.status === "failed" || event.status === "unknown"
      ? { errorText: message }
      : { errorText: undefined }),
  }
}
