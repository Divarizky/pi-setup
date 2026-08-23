import type { SubagentSnapshot } from "./domain.ts"
import {
  ActionQueue,
  type ActionEventType,
  type ActionRecord,
} from "./action-queue.ts"

export type SemanticStatus = "busy" | "idle" | "unknown" | "dead"

export interface ExternalStatusEvidence {
  readonly jobId: string
  readonly status: SemanticStatus
  readonly source: string
  readonly at: number
  readonly eventName?: string
  readonly evidence?: string
  readonly identityVerified?: boolean
}

export interface SubagentMonitorOptions {
  readonly staleAfterMs?: number
  readonly externalStaleAfterMs?: number
  readonly clockSkewMs?: number
  readonly checkEveryMs?: number
  readonly now?: () => number
}

export function classifyStatus(
  snapshot: SubagentSnapshot,
  now = Date.now(),
  staleAfterMs = 30_000,
): SemanticStatus {
  if (snapshot.status === "error") return "dead"
  if (snapshot.status === "done") return "idle"
  const lastEventAt = snapshot.metrics.lastEventAt
  if (!Number.isFinite(lastEventAt) || lastEventAt <= 0 || now - lastEventAt > staleAfterMs) {
    return "unknown"
  }
  return "busy"
}

function monitorSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      ...(snapshot.meta.worktree ? { worktree: { ...snapshot.meta.worktree } } : {}),
    },
  }
}

function actionId(jobId: string, type: ActionEventType, snapshot: SubagentSnapshot) {
  const evidenceAt = snapshot.settledAt ?? snapshot.metrics.lastEventAt
  return `action:${jobId}:${type}:${evidenceAt}`
}

function evidenceActionId(evidence: ExternalStatusEvidence, type: ActionEventType) {
  return `action:${evidence.jobId}:${type}:${evidence.at}`
}

/**
 * Zero-token subagent monitor. It observes manager snapshots, classifies
 * status from structured evidence, and appends durable action events. It never
 * calls an LLM and never performs delivery or destructive operations.
 */
export class SubagentMonitor {
  private readonly statuses = new Map<string, SemanticStatus>()
  private readonly externalStatuses = new Map<string, SemanticStatus>()
  private readonly snapshots = new Map<string, SubagentSnapshot>()
  private timer?: ReturnType<typeof setInterval>
  private readonly staleAfterMs: number
  private readonly checkEveryMs: number
  private readonly externalStaleAfterMs: number
  private readonly clockSkewMs: number
  private readonly now: () => number
  readonly queue: ActionQueue

  constructor(
    queue: ActionQueue,
    options: SubagentMonitorOptions = {},
  ) {
    this.queue = queue
    this.staleAfterMs = options.staleAfterMs ?? 30_000
    this.externalStaleAfterMs = options.externalStaleAfterMs ?? 30_000
    this.clockSkewMs = options.clockSkewMs ?? 5_000
    this.checkEveryMs = options.checkEveryMs ?? 5_000
    this.now = options.now ?? Date.now
  }

  async observe(snapshot: SubagentSnapshot): Promise<ReadonlyArray<ActionRecord>> {
    const currentStatus = classifyStatus(snapshot, this.now(), this.staleAfterMs)
    const previousStatus = this.statuses.get(snapshot.id)
    const previousSnapshot = this.snapshots.get(snapshot.id)
    this.statuses.set(snapshot.id, currentStatus)
    // Manager snapshots are mutable read-model objects. Keep a comparison
    // copy so later in-place transitions cannot rewrite our history.
    this.snapshots.set(snapshot.id, monitorSnapshot(snapshot))
    if (!previousSnapshot) {
      if (snapshot.errorText?.includes("restarted")) {
        return [await this.enqueue(snapshot, "recovery_required", "Job requires recovery after restart.")]
      }
      return []
    }

    const actions: ActionRecord[] = []
    if (previousSnapshot.status !== "done" && snapshot.status === "done") {
      actions.push(await this.enqueue(snapshot, "job_settled", "Subagent completed and requires review."))
      if (snapshot.meta.mode === "build" && snapshot.meta.worktree) {
        actions.push(await this.enqueue(snapshot, "approval_required", "Build delivery requires explicit approval."))
      }
    } else if (previousSnapshot.status !== "error" && snapshot.status === "error") {
      const recoveryRequired = snapshot.errorText?.toLowerCase().includes("recovery_required") === true
      actions.push(await this.enqueue(
        snapshot,
        recoveryRequired ? "recovery_required" : "job_failed",
        snapshot.errorText ?? "Subagent failed.",
      ))
    } else if (previousStatus !== "unknown" && currentStatus === "unknown") {
      actions.push(await this.enqueue(snapshot, "status_unknown", "Subagent status is stale or unverifiable."))
    }
    return actions
  }

  async observeEvidence(evidence: ExternalStatusEvidence): Promise<ReadonlyArray<ActionRecord>> {
    const now = this.now()
    const stale = !Number.isFinite(evidence.at)
      || evidence.at > now + this.clockSkewMs
      || now - evidence.at > this.externalStaleAfterMs
    const identityMismatch = evidence.identityVerified === false
    const snapshot = this.snapshots.get(evidence.jobId)
    const localStatus = snapshot ? classifyStatus(snapshot, now, this.staleAfterMs) : undefined
    const conflicting = !stale && !identityMismatch && localStatus !== undefined
      && ((evidence.status === "idle" && localStatus === "busy")
        || (evidence.status === "busy" && localStatus === "idle"))
    const effectiveStatus: SemanticStatus = stale || identityMismatch || conflicting ? "unknown" : evidence.status
    const previous = this.externalStatuses.get(evidence.jobId)
    this.externalStatuses.set(evidence.jobId, effectiveStatus)
    if (previous === effectiveStatus) return []

    if (identityMismatch) {
      return [await this.queue.enqueue({
        actionId: evidenceActionId(evidence, "identity_mismatch"),
        jobId: evidence.jobId,
        type: "identity_mismatch",
        at: evidence.at,
        message: `External ${evidence.source} identity does not match the persisted job.`,
        evidence: evidence.evidence ?? evidence.eventName,
      })]
    }
    if (effectiveStatus === "unknown") {
      return [await this.queue.enqueue({
        actionId: evidenceActionId(evidence, "status_unknown"),
        jobId: evidence.jobId,
        type: "status_unknown",
        at: evidence.at,
        message: stale
          ? `External ${evidence.source} status evidence is stale or outside the clock window.`
          : conflicting
            ? `External ${evidence.source} status conflicts with local structured state.`
            : `External ${evidence.source} status is unknown.`,
        evidence: evidence.evidence ?? evidence.eventName,
      })]
    }
    if (effectiveStatus === "dead") {
      return [await this.queue.enqueue({
        actionId: evidenceActionId(evidence, "session_dead"),
        jobId: evidence.jobId,
        type: "session_dead",
        at: evidence.at,
        message: `External ${evidence.source} session is dead.`,
        evidence: evidence.evidence ?? evidence.eventName,
      })]
    }
    return []
  }

  async reconcile(snapshots: ReadonlyArray<SubagentSnapshot>) {
    const actions: ActionRecord[] = []
    for (const snapshot of snapshots) actions.push(...await this.observe(snapshot))
    return actions
  }

  start(
    provider: () => ReadonlyArray<SubagentSnapshot>,
    externalProvider?: () => Promise<ReadonlyArray<ExternalStatusEvidence>>,
  ) {
    if (this.timer) return
    this.timer = setInterval(() => {
      void (async () => {
        await this.reconcile(provider())
        if (externalProvider) {
          for (const evidence of await externalProvider()) {
            await this.observeEvidence(evidence)
          }
        }
      })().catch(() => {
        // Durable queue errors are surfaced by the next explicit queue action.
      })
    }, this.checkEveryMs)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Forget all in-memory evidence before a job is deleted. */
  async forgetJob(jobId: string): Promise<void> {
    this.statuses.delete(jobId)
    this.externalStatuses.delete(jobId)
    this.snapshots.delete(jobId)
    await this.queue.deleteJob(jobId)
  }

  private async enqueue(snapshot: SubagentSnapshot, type: ActionEventType, message: string) {
    return this.queue.enqueue({
      actionId: actionId(snapshot.id, type, snapshot),
      jobId: snapshot.id,
      type,
      at: this.now(),
      message,
      evidence: snapshot.errorText ?? snapshot.finalText.slice(0, 1_000),
    })
  }
}
