import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { validateWorkflowTransition, type WorkflowEvent, type WorkflowTaskStatus } from "./state.ts"

export interface WorkflowEventRecord {
  readonly sequence: number
  readonly taskId: string
  readonly event: WorkflowEvent
}

export interface WorkflowWake {
  readonly id: string
  readonly sequence: number
  readonly taskId: string
  readonly generation: number
  readonly status: WorkflowTaskStatus
  readonly message?: string
  readonly createdAt: number
  readonly acknowledgedAt?: number
}

interface StoredWakeState {
  readonly version: 1
  readonly wakes: ReadonlyArray<WorkflowWake>
}

const ACTIONABLE_STATUSES: ReadonlySet<WorkflowTaskStatus> = new Set([
  "blocked",
  "needs-decision",
  "done",
  "failed",
  "unknown",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseEvent(value: unknown): WorkflowEventRecord {
  if (!isRecord(value) || typeof value.sequence !== "number" || typeof value.taskId !== "string") {
    throw new Error("Malformed workflow event record.")
  }
  const event = value.event
  if (!isRecord(event) || event.type !== "status" || typeof event.status !== "string" || typeof event.at !== "number") {
    throw new Error("Malformed workflow event.")
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.taskId.length === 0) {
    throw new Error("Malformed workflow event identity.")
  }
  if (event.generation !== undefined && (typeof event.generation !== "number" || !Number.isSafeInteger(event.generation) || event.generation < 1)) {
    throw new Error("Malformed workflow event generation.")
  }
  return {
    sequence: value.sequence,
    taskId: value.taskId,
    event: {
      type: "status",
      status: event.status as WorkflowTaskStatus,
      at: event.at,
      ...(typeof event.generation === "number" ? { generation: event.generation } : {}),
      ...(typeof event.message === "string" ? { message: event.message.slice(0, 4_096) } : {}),
    },
  }
}

function parseWake(value: unknown): WorkflowWake {
  if (!isRecord(value)) throw new Error("Malformed workflow wake.")
  if (
    typeof value.id !== "string" || typeof value.sequence !== "number"
    || typeof value.taskId !== "string" || typeof value.status !== "string"
    || typeof value.createdAt !== "number"
  ) throw new Error("Malformed workflow wake fields.")
  const generation = value.generation === undefined ? 1 : value.generation
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Malformed workflow wake generation.")
  }
  if (value.acknowledgedAt !== undefined && typeof value.acknowledgedAt !== "number") {
    throw new Error("Malformed workflow wake acknowledgement.")
  }
  return {
    id: value.id,
    sequence: value.sequence,
    taskId: value.taskId,
    generation,
    status: value.status as WorkflowTaskStatus,
    ...(typeof value.message === "string" ? { message: value.message.slice(0, 4_096) } : {}),
    createdAt: value.createdAt,
    ...(typeof value.acknowledgedAt === "number" ? { acknowledgedAt: value.acknowledgedAt } : {}),
  }
}

/** Durable append-only workflow events plus acknowledged actionable wakes. */
export class WorkflowEventQueue {
  readonly eventsPath: string
  readonly wakesPath: string
  private readonly eventRecords: WorkflowEventRecord[] = []
  private readonly wakesById = new Map<string, WorkflowWake>()
  private readonly currentStatuses = new Map<string, WorkflowTaskStatus>()
  private readonly latestGenerations = new Map<string, number>()
  private writeChain: Promise<void> = Promise.resolve()
  private nextSequence = 1

  constructor(rootDir: string) {
    this.eventsPath = path.join(rootDir, "workflow-events.jsonl")
    this.wakesPath = path.join(rootDir, "workflow-wakes.json")
  }

  async restore(): Promise<void> {
    this.eventRecords.length = 0
    this.wakesById.clear()
    this.currentStatuses.clear()
    this.latestGenerations.clear()
    this.nextSequence = 1

    try {
      const raw = await readFile(this.eventsPath, "utf8")
      for (const line of raw.split(/\r?\n/).filter((line) => line.trim().length > 0)) {
        const record = parseEvent(JSON.parse(line))
        this.applyStatus(record.taskId, record.event)
        this.eventRecords.push(record)
        this.nextSequence = Math.max(this.nextSequence, record.sequence + 1)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot restore workflow events: ${String(error)}`)
      }
    }

    try {
      const raw = await readFile(this.wakesPath, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.wakes)) {
        throw new Error("Unsupported workflow wake schema.")
      }
      for (const value of parsed.wakes) {
        const wake = parseWake(value)
        if (this.wakesById.has(wake.id)) throw new Error(`Duplicate workflow wake: ${wake.id}`)
        this.wakesById.set(wake.id, wake)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot restore workflow wakes: ${String(error)}`)
      }
    }
    for (const record of this.eventRecords) {
      if (!ACTIONABLE_STATUSES.has(record.event.status)) continue
      const id = `wake-${record.sequence}`
      if (this.wakesById.has(id)) continue
      this.wakesById.set(id, {
        id,
        sequence: record.sequence,
        taskId: record.taskId,
        generation: record.event.generation ?? 1,
        status: record.event.status,
        ...(record.event.message === undefined ? {} : { message: record.event.message.slice(0, 4_096) }),
        createdAt: record.event.at,
      })
    }
  }

  async publish(taskId: string, event: WorkflowEvent): Promise<{
    readonly event: WorkflowEventRecord
    readonly wake?: WorkflowWake
  }> {
    if (!taskId.trim()) throw new Error("Workflow event requires a task id.")
    this.applyStatus(taskId, event)
    const record: WorkflowEventRecord = {
      sequence: this.nextSequence++,
      taskId,
      event,
    }
    this.eventRecords.push(record)
    let wake: WorkflowWake | undefined
    if (ACTIONABLE_STATUSES.has(event.status)) {
      wake = {
        id: `wake-${record.sequence}`,
        sequence: record.sequence,
        taskId,
        generation: event.generation ?? 1,
        status: event.status,
        ...(event.message === undefined ? {} : { message: event.message.slice(0, 4_096) }),
        createdAt: event.at,
      }
      this.wakesById.set(wake.id, wake)
    }
    await this.enqueueWrite(async () => {
      await mkdir(path.dirname(this.eventsPath), { recursive: true })
      await appendFile(this.eventsPath, `${JSON.stringify(record)}\n`, "utf8")
      if (wake) await this.writeWakes()
    })
    return { event: record, wake }
  }

  events(taskId?: string): ReadonlyArray<WorkflowEventRecord> {
    return this.eventRecords
      .filter((record) => taskId === undefined || record.taskId === taskId)
      .map((record) => ({ ...record, event: { ...record.event } }))
  }

  latestGeneration(taskId: string): number | undefined {
    return this.latestGenerations.get(taskId)
  }

  status(taskId: string, generation = this.latestGenerations.get(taskId) ?? 1): WorkflowTaskStatus | undefined {
    return this.currentStatuses.get(`${taskId}:${generation}`)
  }

  pending(): ReadonlyArray<WorkflowWake> {
    return [...this.wakesById.values()]
      .filter((wake) => wake.acknowledgedAt === undefined)
      .sort((a, b) => a.sequence - b.sequence)
      .map((wake) => ({ ...wake }))
  }

  async acknowledge(id: string): Promise<boolean> {
    const wake = this.wakesById.get(id)
    if (!wake || wake.acknowledgedAt !== undefined) return false
    this.wakesById.set(id, { ...wake, acknowledgedAt: Date.now() })
    await this.enqueueWrite(() => this.writeWakes())
    return true
  }

  private applyStatus(taskId: string, event: WorkflowEvent) {
    const generation = event.generation ?? 1
    const latest = this.latestGenerations.get(taskId)
    if (latest === undefined && generation !== 1) {
      throw new Error(`Invalid workflow generation for ${taskId}: expected 1, got ${generation}.`)
    }
    if (latest !== undefined && generation < latest) {
      throw new Error(`Stale workflow generation for ${taskId}: ${generation} < ${latest}.`)
    }
    if (latest !== undefined && generation > latest + 1) {
      throw new Error(`Skipped workflow generation for ${taskId}: ${generation} > ${latest + 1}.`)
    }
    const key = `${taskId}:${generation}`
    const current = this.currentStatuses.get(key) ?? "queued"
    if (latest !== undefined && generation === latest + 1 && event.status !== "working") {
      throw new Error(`New workflow generation for ${taskId} must start working.`)
    }
    validateWorkflowTransition(current, event.status)
    this.currentStatuses.set(key, event.status)
    this.latestGenerations.set(taskId, Math.max(latest ?? 0, generation))
  }

  async acknowledgeTask(taskId: string): Promise<number> {
    const ids = this.pending()
      .filter((wake) => wake.taskId === taskId)
      .map((wake) => wake.id)
    for (const id of ids) await this.acknowledge(id)
    return ids.length
  }

  private writeWakes(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.wakesPath), { recursive: true })
      const temporary = `${this.wakesPath}.tmp-${process.pid}-${Date.now()}`
      const state: StoredWakeState = { version: 1, wakes: [...this.wakesById.values()] }
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
      await rename(temporary, this.wakesPath)
    }
    return operation()
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation)
    this.writeChain = result.then(() => undefined, () => undefined)
    return result
  }
}
