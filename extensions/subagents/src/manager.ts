/**
 * SubagentManager — owns the registry of running and finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its event stream into a mutable `SubagentSnapshot`.
 */

import { Context, Duration, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect"
import type { SessionStatusEvidence, SubagentBackend, SubagentSession } from "./backend.ts"
import type { JobEvent, PersistedJob } from "./persistence.ts"
import { canRetry, retryDelay } from "./recovery.ts"
import type { SubagentWorktree } from "./worktree.ts"
import { BackendRegistry } from "./backend.ts"
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentOrigin,
  SubagentMeta,
  SubagentReport,
  SubagentEventLog,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts"
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  SendError,
  SpawnError,
} from "./domain.ts"

export const MAX_RUNNING = 4
export const MAX_TRACKED = 64
const STOP_TIMEOUT_MS = 5_000
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000
const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60_000
const ERROR_TEXT_MAX_LENGTH = 4_096
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024
const MAX_TRANSCRIPT_ITEMS = 512
const MAX_EVENT_LOG_ITEMS = 128

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH)
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH)
}

function parseStructuredReport(text: string): SubagentReport | undefined {
  const match = text.match(/<subagent-report>\s*([\s\S]*?)\s*<\/subagent-report>/i)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[1]) as Partial<SubagentReport>
    if (!value.outcome || !value.summary || !Array.isArray(value.changes) || !Array.isArray(value.tests)) return undefined
    if (!["success", "failed", "blocked", "timeout", "cancelled"].includes(value.outcome)) return undefined
    const rawError = value.error
    const validPhases = ["analysis", "implementation", "test", "environment", "runtime"] as const
    const error = rawError && typeof rawError === "object" && validPhases.includes(rawError.phase)
      && typeof rawError.message === "string"
      ? {
          phase: rawError.phase,
          message: bounded(rawError.message),
          cause: typeof rawError.cause === "string" ? bounded(rawError.cause) : undefined,
          recovery: typeof rawError.recovery === "string" ? bounded(rawError.recovery) : undefined,
        }
      : undefined
    return {
      outcome: value.outcome,
      summary: bounded(String(value.summary)),
      changes: value.changes.map(String).slice(0, 100),
      tests: value.tests.slice(0, 100).map((test) => ({
        command: bounded(String(test.command)),
        passed: test.passed === true,
        output: test.output === undefined ? undefined : bounded(String(test.output)),
      })),
      error,
      needsParentDecision: value.needsParentDecision === true,
    }
  } catch {
    return undefined
  }
}

function reportFor(outcome: RunOutcome, finalText: string, errorText?: string): SubagentReport {
  const parsed = parseStructuredReport(finalText)
  switch (outcome._tag) {
    case "Completed":
      return parsed?.outcome === "success" || parsed?.outcome === "blocked"
        ? parsed
        : {
            outcome: "blocked",
            summary: "Subagent completed without a valid structured report.",
            changes: [],
            tests: [],
            error: {
              phase: "runtime",
              message: "The final output did not contain a valid <subagent-report> JSON payload.",
              recovery: "Review the final output and retry with the structured report contract included.",
            },
            needsParentDecision: true,
          }
    case "TimedOut":
      return {
        outcome: "timeout",
        summary: "Subagent exceeded its run timeout.",
        changes: [],
        tests: [],
        error: {
          phase: "runtime",
          message: `Run timed out after ${outcome.timeoutMs}ms.`,
          recovery: "Review the partial output, then retry with a narrower task or a longer timeout.",
        },
        needsParentDecision: true,
      }
    case "Interrupted":
      return {
        outcome: "cancelled",
        summary: "Subagent run was cancelled.",
        changes: [],
        tests: [],
        needsParentDecision: false,
      }
    case "Failed":
      return parsed
        ? { ...parsed, outcome: parsed.outcome === "blocked" ? "blocked" : "failed", needsParentDecision: true }
        : {
            outcome: "failed",
            summary: finalText.trim() || "Subagent failed before producing a final summary.",
            changes: [],
            tests: [],
            error: {
              phase: "runtime",
              message: bounded(errorText ?? outcome.errorText),
              recovery: "Inspect the partial output and error, then retry or adjust the task.",
            },
            needsParentDecision: true,
          }
  }
}

function appendEvent(snapshot: MutableSnapshot, event: string, message?: string) {
  const item: SubagentEventLog = { at: Date.now(), event, message: message ? bounded(message) : undefined }
  snapshot.eventLog.push(item)
  snapshot.metrics.lastEventAt = item.at
  if (snapshot.eventLog.length > MAX_EVENT_LOG_ITEMS) {
    snapshot.eventLog.splice(0, snapshot.eventLog.length - MAX_EVENT_LOG_ITEMS)
  }
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
  snapshot.transcript.push(item)
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(0, snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS)
  }
}

// --- Internal state -----------------------------------------------------------

interface MutableSnapshot {
  id: string
  origin: SubagentOrigin
  backend: BackendName
  title: string
  prompt: string
  cwd: string
  status: SubagentStatus
  restarting?: boolean
  createdAt: number
  settledAt?: number
  errorText?: string
  report?: SubagentReport
  metrics: { runCount: number; restartCount: number; timeoutCount: number; startedAt: number; lastEventAt: number }
  eventLog: SubagentEventLog[]
  meta: SubagentMeta
  usage: { tokens?: number; contextWindow?: number }
  transcript: TranscriptItem[]
  liveAssistant?: { text: string; thinking: string }
  liveTools: LiveToolState[]
  queued: SubagentSnapshot["queued"]
  finalText: string
  turns: number
}

interface Entry {
  snapshot: MutableSnapshot
  session: SubagentSession
  scope: Scope.Closeable
  pump?: Fiber.Fiber<void>
  liveToolMap: Map<string, LiveToolState>
  /** True while a new run is being dispatched but RunStarted has not folded yet. */
  restarting?: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
  armTimeout?: () => void
  timeoutMs: number
  timedOut?: boolean
}

// --- Read model ----------------------------------------------------------------

export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>
  get(id: string): SubagentSnapshot | undefined
  size(): number
  subscribe(listener: () => void): () => void
  subscribeTo(id: string, listener: () => void): () => void
  requestSend(id: string, text: string, onError?: (message: string) => void): void
  requestAbort(id: string, onError?: (message: string) => void): void
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void
}

// --- Service ----------------------------------------------------------------

export interface CancelResult {
  readonly id: string
  readonly title: string
  readonly status: SubagentStatus
  readonly cancelled: boolean
}

export interface SubagentManagerShape {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<SubagentSnapshot, SpawnError | ConcurrencyLimitError | BackendUnavailableError>
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>
  cancel(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CancelResult>>
  closeSession(id: string): Effect.Effect<void>
  /** True only for a session owned by this live extension runtime, never a restored snapshot. */
  hasLiveSession(id: string): Effect.Effect<boolean>
  send(id: string, text: string): Effect.Effect<void, SendError>
  retry(id: string, text?: string): Effect.Effect<void, SendError>
  forget(id: string): Effect.Effect<SubagentSnapshot | undefined>
  probeStatuses(): Effect.Effect<ReadonlyArray<SessionStatusEvidence>>
  markRecoveryRequired(id: string, reason: string): Effect.Effect<SubagentSnapshot | undefined>
  reattach(id: string): Effect.Effect<SubagentSnapshot, SpawnError | ConcurrencyLimitError | BackendUnavailableError>
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>
  restore(jobs: ReadonlyArray<PersistedJob>, events?: ReadonlyArray<JobEvent>): Effect.Effect<void>
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>
  readonly disposeAll: Effect.Effect<void>
  readonly view: SubagentReadModel
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation ------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry

  const entries = new Map<string, Entry>()
  const archived = new Map<string, SubagentSnapshot>()
  const waitInterest = new Map<string, number>()
  const listeners = new Set<() => void>()
  let changeWaiters: Array<() => void> = []
  const idListeners = new Map<string, Set<() => void>>()
  const cleanups = new Set<Fiber.Fiber<unknown>>()
  let modelCounter = 0
  let qaCounter = 0
  let reserved = 0
  let disposed = false
  let onSettled:
    | ((snap: SubagentSnapshot, consumed: boolean) => void)
    | undefined

  // runDetached: fire-and-forget commands from the synchronous read model.
  const context = yield* Effect.context()
  const runDetached = (effect: Effect.Effect<unknown>) =>
    Effect.runFork(effect, { context } as any)

  const notify = (id?: string) => {
    const waiters = changeWaiters
    changeWaiters = []
    for (const waiter of waiters) waiter()
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // listeners must not corrupt state
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener()
        } catch {
          // same
        }
      }
    }
  }

  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void)
    changeWaiters.push(waiter)
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter)
      if (index >= 0) changeWaiters.splice(index, 1)
    })
  })

  const runningCount = () =>
    [...entries.values()].filter(
      (e) => e.snapshot.status === "running" || e.restarting === true,
    ).length

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1)
  }
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1
      if (count <= 0) waitInterest.delete(id)
      else waitInterest.set(id, count)
    }
  }

  const closeEntryScope = (entry: Entry) =>
    Effect.sync(() => {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = undefined
    }).pipe(Effect.andThen(Scope.close(entry.scope, Exit.void)), Effect.ignore)

  const restore = (jobs: ReadonlyArray<PersistedJob>, events: ReadonlyArray<JobEvent> = []) =>
    Effect.sync(() => {
      for (const job of jobs) {
        if (entries.has(job.jobId) || archived.has(job.jobId)) continue
        const orphaned = job.status === "running"
        const status: SubagentStatus = orphaned ? "error" : job.status
        const settledAt = job.settledAt ?? (orphaned ? Date.now() : undefined)
        const worktree: SubagentWorktree | undefined = job.worktreePath && job.branch && job.repoRoot
          ? { jobId: job.jobId, path: job.worktreePath, branch: job.branch, repoRoot: job.repoRoot }
          : undefined
        const snapshot: SubagentSnapshot = {
          id: job.jobId,
          origin: "model",
          backend: job.backend ?? "pi",
          title: job.title,
          prompt: "[restored from durable state]",
          cwd: job.cwd,
          status,
          createdAt: job.createdAt,
          settledAt,
          errorText: orphaned
            ? "Job was running when the agent restarted; recovery is required."
            : job.errorText,
          metrics: {
            runCount: 0,
            restartCount: 0,
            timeoutCount: 0,
            startedAt: job.createdAt,
            lastEventAt: settledAt ?? job.createdAt,
          },
          eventLog: [
            ...events
              .filter((event) => event.jobId === job.jobId)
              .slice(-MAX_EVENT_LOG_ITEMS)
              .map((event) => ({
                at: event.at,
                event: event.event,
                ...(event.message === undefined ? {} : { message: event.message }),
              })),
            {
              at: Date.now(),
              event: orphaned ? "RestoredOrphaned" : "Restored",
            },
          ].slice(-MAX_EVENT_LOG_ITEMS),
          meta: {
            backend: job.backend ?? "pi",
            mode: job.mode,
            worktree,
            ...(job.sessionFilePath === undefined ? {} : { sessionFilePath: job.sessionFilePath }),
            ...(job.nativeSessionId === undefined ? {} : { nativeSessionId: job.nativeSessionId }),
            ...(job.nativeTerminalHandle === undefined ? {} : { nativeTerminalHandle: job.nativeTerminalHandle }),
            ...(job.nativeWorktreeId === undefined ? {} : { nativeWorktreeId: job.nativeWorktreeId }),
            ...(job.nativeTabId === undefined ? {} : { nativeTabId: job.nativeTabId }),
            ...(job.nativePaneKey === undefined ? {} : { nativePaneKey: job.nativePaneKey }),
            ...(job.nativeLaunchToken === undefined ? {} : { nativeLaunchToken: job.nativeLaunchToken }),
          },
          usage: {},
          transcript: [],
          liveTools: [],
          queued: [],
          finalText: "",
          turns: 0,
        }
        archived.set(job.jobId, snapshot)
        const match = job.jobId.match(/^sa-(\d+)$/)
        if (match) modelCounter = Math.max(modelCounter, Number(match[1]))
        const qaMatch = job.jobId.match(/^qa-(\d+)$/)
        if (qaMatch) qaCounter = Math.max(qaCounter, Number(qaMatch[1]))
      }
      notify()
    })

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return
    const candidates = [...entries.values()]
      .filter((e) => e.snapshot.status !== "running" && !e.restarting && !waitInterest.has(e.snapshot.id))
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      )
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break
      entries.delete(entry.snapshot.id)
      const fiber = runDetached(closeEntryScope(entry))
      cleanups.add(fiber)
      fiber.addObserver(() => cleanups.delete(fiber))
    }
  }

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot
    entry.restarting = false
    s.restarting = false
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = undefined
    }
    if (s.status !== "running") return
    s.settledAt = Date.now()
    switch (outcome._tag) {
      case "Completed":
        s.status = "done"
        s.errorText = undefined
        s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH)
        break
      case "Failed":
        s.status = "error"
        s.errorText = bounded(outcome.errorText)
        s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH)
        break
      case "Interrupted":
        if (entry.timedOut) {
          s.metrics.timeoutCount++
          s.status = "error"
          s.errorText = `Run timed out after ${entry.timeoutMs}ms`
          s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH)
          outcome = { _tag: "TimedOut", timeoutMs: entry.timeoutMs, partialText: outcome.partialText }
        } else {
          s.status = "error"
          s.errorText = "Run was aborted"
          s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH)
        }
        break
      case "TimedOut":
        s.metrics.timeoutCount++
        s.status = "error"
        s.errorText = `Run timed out after ${outcome.timeoutMs}ms`
        s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH)
        break
    }
    s.report = reportFor(outcome, s.finalText, s.errorText)
    s.liveAssistant = undefined
    entry.liveToolMap.clear()
    s.liveTools = []
    s.queued = []
    const consumed = (waitInterest.get(s.id) ?? 0) > 0
    notify(s.id)
    if (!disposed) {
      try {
        onSettled?.(s, consumed)
      } catch {
        // parent may be unavailable
      }
    }
    pruneSettled()
  }

  const markRecoveryRequired = (id: string, reason: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id)
      const message = `recovery_required: ${bounded(reason)}`
      if (entry) {
        if (entry.snapshot.status === "running" || entry.restarting === true) {
          // Keep the session object alive for a bounded retry. The backend can
          // reacquire a replacement terminal on the next attempt; explicit
          // deletion still closes the session through closeSession().
          appendEvent(entry.snapshot, "RecoveryRequired", message)
          settle(entry, { _tag: "Failed", errorText: message })
        }
        return entry.snapshot as SubagentSnapshot
      }
      const archivedSnapshot = archived.get(id)
      if (!archivedSnapshot) return undefined
      if (archivedSnapshot.status !== "error") {
        const snapshot = archivedSnapshot as MutableSnapshot
        snapshot.status = "error"
        snapshot.settledAt = Date.now()
        snapshot.errorText = message
        snapshot.report = reportFor({ _tag: "Failed", errorText: message }, snapshot.finalText, message)
        appendEvent(snapshot, "RecoveryRequired", message)
        notify(id)
      }
      return archivedSnapshot
    })

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot
    appendEvent(
      s,
      event._tag,
      event._tag === "BackendError"
        ? event.message
        : event._tag === "RunSettled" && event.outcome._tag === "Failed"
          ? event.outcome.errorText
          : undefined,
    )
    switch (event._tag) {
      case "RunStarted":
        if (s.metrics.runCount > 0) s.metrics.restartCount++
        s.metrics.runCount++
        entry.restarting = false
        s.restarting = false
        entry.timedOut = false
        s.status = "running"
        s.settledAt = undefined
        s.errorText = undefined
        entry.armTimeout?.()
        break
      case "RunSettled":
        settle(entry, event.outcome)
        return
      case "UserMessage":
        appendTranscript(s, { kind: "user", text: boundedTranscriptText(event.text) })
        break
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" }
        s.liveAssistant =
          event.kind === "text"
            ? { ...live, text: (live.text + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH) }
            : { ...live, thinking: (live.thinking + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH) }
        break
      }
      case "AssistantMessage":
        appendTranscript(s, {
          kind: "assistant",
          parts: event.parts.map((part) =>
            part.type === "toolCall"
              ? {
                  ...part,
                  argsPreview: part.argsPreview
                    ? boundedTranscriptText(part.argsPreview)
                    : undefined,
                }
              : { ...part, text: boundedTranscriptText(part.text) },
          ),
        })
        s.liveAssistant = undefined
        s.turns++
        break
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview
            ? boundedTranscriptText(event.argsPreview)
            : undefined,
        })
        s.liveTools = [...entry.liveToolMap.values()]
        break
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId)
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          })
          s.liveTools = [...entry.liveToolMap.values()]
        }
        break
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId)
        s.liveTools = [...entry.liveToolMap.values()]
        appendTranscript(s, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
        })
        break
      case "QueueChanged":
        s.queued = event.queued
        break
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
        }
        break
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta }
        break
      case "BackendError":
        s.errorText = bounded(event.message)
        break
    }
    notify(s.id)
  }

  const activateEntry = (entry: Entry) =>
    Effect.gen(function* () {
      const pump = Stream.runForEach(entry.session.events, (event) =>
        Effect.sync(() => foldEvent(entry, event)),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.snapshot.status === "running") {
              settle(entry, {
                _tag: "Failed",
                errorText: "Backend event stream ended unexpectedly",
              })
            }
          }),
        ),
      )
      entry.pump = yield* Scope.provide(Effect.forkScoped(pump), entry.scope)
      const armTimeout = () => {
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
        entry.timeoutTimer = setTimeout(() => {
          runDetached(
            Effect.gen(function* () {
              if (entry.snapshot.status !== "running" && !entry.restarting) return
              entry.timedOut = true
              const partialText = entry.snapshot.liveAssistant?.text || entry.snapshot.finalText || undefined
              yield* entry.session.interrupt.pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore)
              yield* Effect.sync(() => {
                if (entry.snapshot.status === "running") {
                  settle(entry, {
                    _tag: "TimedOut",
                    timeoutMs: entry.timeoutMs,
                    partialText,
                  })
                } else if (entry.restarting) {
                  // A follow-up can hang before RunStarted. Promote the
                  // restarting entry to a normal failed run so it cannot hold
                  // a concurrency slot forever.
                  entry.snapshot.status = "running"
                  settle(entry, {
                    _tag: "Failed",
                    errorText: `Follow-up did not start within ${entry.timeoutMs}ms`,
                    partialText,
                  })
                }
              })
            }).pipe(Effect.ignore),
          )
        }, entry.timeoutMs)
      }
      entry.armTimeout = armTimeout
      armTimeout()
      entries.set(entry.snapshot.id, entry)
      notify(entry.snapshot.id)
    })

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    Effect.gen(function* () {
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({ message: "Subagent manager is shutting down." })
          }
          if (runningCount() + reserved >= MAX_RUNNING) {
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
            })
          }
          reserved++
          return Effect.void
        },
      )

      const doSpawn = Effect.gen(function* () {
        if (task.mode === "scout" && backendName !== "pi") {
          return yield* new SpawnError({ message: "Scout only supports the Pi backend and never creates a worktree." })
        }
        if (task.mode === "build" && backendName !== "orca") {
          return yield* new SpawnError({ message: "Build requires the Orca backend with a Pi agent and managed worktree." })
        }
        const backend: SubagentBackend | undefined = registry.get(backendName)
        if (!backend) {
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          })
        }
        const available = yield* backend.available
        if (!available) {
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine.`,
          })
        }
        if (task.model && !backend.capabilities.modelSelection) {
          return yield* new SpawnError({
            message: `Backend "${backendName}" does not support model selection. Omit model or use a compatible backend.`,
          })
        }
        if (task.reasoningEffort && !backend.capabilities.reasoningEffort) {
          return yield* new SpawnError({
            message: `Backend "${backendName}" does not support reasoning effort selection. Omit reasoning_effort or use a compatible backend.`,
          })
        }

        const origin = task.origin ?? "model"
        const requestedId = task.jobId?.trim()
        const id = requestedId || (origin === "quick-ask" ? `qa-${++qaCounter}` : `sa-${++modelCounter}`)
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
          return yield* new SpawnError({ message: "Spawn job_id contains unsupported characters." })
        }
        if (entries.has(id) || archived.has(id)) {
          return yield* new SpawnError({ message: `Spawn job_id "${id}" is already tracked.` })
        }
        const modelId = id.match(/^sa-(\d+)$/)
        if (modelId) modelCounter = Math.max(modelCounter, Number(modelId[1]))
        const qaId = id.match(/^qa-(\d+)$/)
        if (qaId) qaCounter = Math.max(qaCounter, Number(qaId[1]))
        const backendTask: SpawnTask = { ...task, jobId: id }

        const scope = yield* Scope.make()
        const session = yield* Scope.provide(backend.spawn(backendTask), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        if (disposed) {
          yield* Scope.close(scope, Exit.void)
          return yield* new SpawnError({ message: "Subagent manager shut down while spawning." })
        }

        const meta = {
          ...(yield* session.meta),
          worktree: task.worktree,
          mode: task.mode ?? "build",
        }
        const entry: Entry = {
          snapshot: {
            id,
            origin,
            backend: backendName,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            status: "running",
            createdAt: Date.now(),
            metrics: {
              runCount: 0,
              restartCount: 0,
              timeoutCount: 0,
              startedAt: Date.now(),
              lastEventAt: Date.now(),
            },
            eventLog: [],
            meta,
            usage: { contextWindow: meta.contextWindow },
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: "",
            turns: 0,
          },
          session,
          scope,
          liveToolMap: new Map(),
          timeoutMs: Math.min(
            Math.max(1, task.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS),
            MAX_RUN_TIMEOUT_MS,
          ),
        }
        entries.set(id, entry)

        yield* activateEntry(entry)
        return entry.snapshot as SubagentSnapshot
      })

      return yield* doSpawn.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reserved--
            notify()
          }),
        ),
      )
    })

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)]
      addInterest(unique)
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const entry = entries.get(id)
            return entry?.snapshot.status === "running" || entry?.restarting === true
          })
          if (pending.length === 0) return
          onPending?.(pending)
          yield* nextChange
        }
      })
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique)
            pruneSettled()
          }),
        ),
      )
    })

  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (entry.snapshot.status !== "running" && !entry.restarting) return
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      )
      if (Result.isFailure(graceful)) {
        yield* Effect.sync(() => {
          settle(entry, { _tag: "Interrupted" })
          entry.snapshot.errorText = "Abort deadline exceeded; session was force-disposed"
          notify(entry.snapshot.id)
        })
        yield* closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore)
      }
    })

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)]
      const running = unique
        .map((id) => entries.get(id))
        .filter((entry): entry is Entry => entry !== undefined && (entry.snapshot.status === "running" || entry.restarting === true))
      const runningIds = running.map((entry) => entry.snapshot.id)
      addInterest(runningIds)
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, { concurrency: "unbounded" })
        while (running.some((entry) => entry.snapshot.status === "running" || entry.restarting === true)) {
          yield* nextChange
        }
      })
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds)
            pruneSettled()
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            }
          }),
        ),
      )
    })

  const closeSession = (id: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id)
      if (!entry) return
      if (entry.snapshot.status === "running" || entry.restarting === true) {
        yield* abortEntry(entry)
      }
      yield* closeEntryScope(entry)
    })

  const hasLiveSession = (id: string) => Effect.sync(() => entries.has(id))

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id)
      if (!entry || disposed) {
        return new SendError({ message: `Subagent "${id}" is no longer tracked.` })
      }
      if (entry.snapshot.status !== "running") {
        if (runningCount() + reserved >= MAX_RUNNING) {
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          })
        }
        entry.restarting = true
        entry.snapshot.restarting = true
        entry.armTimeout?.()
        notify(id)
        return entry.session.send(text).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              entry.restarting = false
              entry.snapshot.restarting = false
              notify(id)
            }),
          ),
        )
      }
      return entry.session.send(text)
    })

  const retry = (id: string, text?: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id)
      if (!entry) return yield* new SendError({ message: `Subagent "${id}" is no longer tracked.` })
      if (!canRetry(entry.snapshot)) {
        return yield* new SendError({
          message: `Subagent "${id}" is not eligible for bounded retry (status=${entry.snapshot.status}, retries=${entry.snapshot.metrics.restartCount}).`,
        })
      }
      const attempt = entry.snapshot.metrics.restartCount + 1
      yield* Effect.sleep(Duration.millis(retryDelay(attempt)))
      yield* send(
        id,
        text?.trim() || `Retry this job after the previous failure. Inspect the preserved output and recover safely (attempt ${attempt}).`,
      )
    })

  const forget = (id: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id)
      if (entry) {
        yield* closeEntryScope(entry)
        entries.delete(id)
        waitInterest.delete(id)
        idListeners.delete(id)
        const snapshot = entry.snapshot as SubagentSnapshot
        notify(id)
        return snapshot
      }
      const snapshot = archived.get(id)
      archived.delete(id)
      waitInterest.delete(id)
      idListeners.delete(id)
      if (snapshot) notify(id)
      return snapshot
    })

  const probeStatuses = Effect.suspend(() => Effect.forEach(
    [...entries.values()].filter((entry) => entry.snapshot.status === "running" || entry.restarting === true),
    (entry) => {
      if (!entry.session.probeStatus) return Effect.succeed(undefined)
      return entry.session.probeStatus.pipe(
        Effect.catch(() => Effect.succeed<SessionStatusEvidence>({
          jobId: entry.snapshot.id,
          status: "unknown",
          source: entry.snapshot.backend,
          at: Date.now(),
          eventName: "status_probe_failed",
          evidence: "Backend status probe failed; refusing to infer lifecycle state.",
        })),
      )
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((evidence) => evidence.filter((item): item is SessionStatusEvidence => item !== undefined)),
  ))

  const reattach = (id: string) =>
    Effect.gen(function* () {
      const restored = archived.get(id)
      if (!restored) return yield* new SpawnError({ message: `Subagent "${id}" is not a restorable archived job.` })
      if (entries.has(id)) return yield* new SpawnError({ message: `Subagent "${id}" is already active.` })
      if (!restored.meta.worktree || !restored.meta.nativeTerminalHandle || !restored.meta.nativeWorktreeId) {
        return yield* new SpawnError({ message: `Subagent "${id}" has incomplete native session identity; refusing reattach.` })
      }
      if (runningCount() + reserved >= MAX_RUNNING) {
        return yield* new ConcurrencyLimitError({ message: `Max ${MAX_RUNNING} subagents can run concurrently.` })
      }
      const backend = registry.get(restored.backend)
      if (!backend?.reattach) {
        return yield* new BackendUnavailableError({ message: `Backend "${restored.backend}" does not support reattach.` })
      }
      if (!(yield* backend.available)) {
        return yield* new BackendUnavailableError({ message: `Backend "${restored.backend}" is not available on this machine.` })
      }
      const scope = yield* Scope.make()
      const task: SpawnTask = {
        jobId: id,
        prompt: restored.prompt,
        title: restored.title,
        cwd: restored.cwd,
        worktree: restored.meta.worktree,
        mode: restored.meta.mode ?? "build",
        parent: { parentCwd: restored.cwd, projectTrusted: true },
      }
      const session = yield* Scope.provide(backend.reattach(task, restored.meta), scope).pipe(
        Effect.onError(() => Scope.close(scope, Exit.void)),
      )
      const snapshot = restored as MutableSnapshot
      snapshot.status = "running"
      snapshot.restarting = undefined
      snapshot.errorText = undefined
      snapshot.settledAt = undefined
      snapshot.metrics.lastEventAt = Date.now()
      appendEvent(snapshot, "Reattached")
      snapshot.meta = { ...snapshot.meta, ...(yield* session.meta), worktree: restored.meta.worktree }
      const entry: Entry = {
        snapshot,
        session,
        scope,
        liveToolMap: new Map(),
        timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      }
      archived.delete(id)
      yield* activateEntry(entry)
      return entry.snapshot as SubagentSnapshot
    })

  const disposeAll = Effect.gen(function* () {
    disposed = true
    const all = [...entries.values()]
    entries.clear()
    yield* Effect.forEach(
      all,
      (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    )
    yield* Effect.forEach(
      [...cleanups],
      (fiber) => Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore)
    yield* Effect.sync(() => notify())
  })

  const view: SubagentReadModel = {
    list: () => [
      ...[...entries.values()].map((entry) => entry.snapshot),
      ...archived.values(),
    ],
    get: (id) => entries.get(id)?.snapshot ?? archived.get(id),
    size: () => entries.size + archived.size,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id)
      if (!set) {
        set = new Set()
        idListeners.set(id, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) idListeners.delete(id)
      }
    },
    requestSend: (id, text, onError) => {
      runDetached(
        send(id, text).pipe(
          Effect.catch((error) => Effect.sync(() => onError?.(error.message))),
        ),
      )
    },
    requestAbort: (id, onError) => {
      const entry = entries.get(id)
      if (!entry) {
        onError?.(`Subagent "${id}" is no longer tracked.`)
        return
      }
      runDetached(
        abortEntry(entry).pipe(
          Effect.catch(() => Effect.sync(() => onError?.("Subagent abort failed."))),
        ),
      )
    },
    setOnSettled: (hook) => {
      onSettled = hook
    },
  }

  yield* Effect.addFinalizer(() => disposeAll)

  return SubagentManager.of({
    spawn,
    waitFor,
    cancel,
    closeSession,
    hasLiveSession,
    send,
    retry,
    forget,
    probeStatuses: () => probeStatuses,
    markRecoveryRequired,
    reattach,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot ?? archived.get(id)),
    restore,
    list: Effect.sync(() => [
      ...[...entries.values()].map((e) => e.snapshot),
      ...archived.values(),
    ]),
    disposeAll,
    view,
  })
})

export const SubagentManagerLive: Layer.Layer<SubagentManager, never, BackendRegistry> =
  Layer.effect(SubagentManager, makeManager)
