import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SUBAGENT_MODES,
  type LeadAgentId,
  type WorkflowTaskId,
} from "../domain.ts";
import {
  applyWorkflowEvent,
  createWorkflowTask,
  type WorkflowEvent,
  type WorkflowTask,
  type WorkflowTaskInput,
  type WorkflowTaskStatus,
  WORKFLOW_STATUSES,
} from "./state.ts";
import { parseLeadAgentEvent, type LeadAgentEvent } from "./orchestration.ts";
import { withDurableWrite } from "../durable-write.ts";

export interface LedgerTaskInput extends WorkflowTaskInput {
  readonly leadAgentId?: LeadAgentId;
  readonly parentTaskId?: WorkflowTaskId;
}

export interface LedgerTask extends WorkflowTask {
  readonly leadAgentId?: LeadAgentId;
  readonly parentTaskId?: WorkflowTaskId;
  readonly generation: number;
}

export interface LedgerEventRecord {
  readonly sequence: number;
  readonly event: LeadAgentEvent;
  readonly acknowledgedAt?: number;
}

interface StoredLedger {
  readonly version: 1;
  readonly tasks: ReadonlyArray<LedgerTask>;
  readonly events: ReadonlyArray<LedgerEventRecord>;
  readonly nextSequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseTask(value: unknown): LedgerTask {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.role !== "string" ||
    !Array.isArray(value.dependsOn) ||
    typeof value.priority !== "number" ||
    typeof value.requiresWorktree !== "boolean" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.generation !== "number"
  ) {
    throw new Error("Malformed task ledger task.");
  }
  if (!value.dependsOn.every((item) => typeof item === "string"))
    throw new Error("Malformed task ledger dependencies.");
  if (!SUBAGENT_MODES.includes(value.mode as (typeof SUBAGENT_MODES)[number]))
    throw new Error("Malformed task ledger mode.");
  if (
    !WORKFLOW_STATUSES.includes(
      value.status as (typeof WORKFLOW_STATUSES)[number],
    )
  )
    throw new Error("Malformed task ledger status.");
  if (
    !Number.isFinite(value.priority) ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt)
  )
    throw new Error("Malformed task ledger numeric fields.");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1)
    throw new Error("Malformed task ledger generation.");
  const role = value.role === "crew-lead" ? "subagent-lead" : value.role;
  if (role !== "worker" && role !== "subagent-lead")
    throw new Error("Malformed task ledger role.");
  return {
    id: value.id,
    title: value.title,
    mode: value.mode as WorkflowTask["mode"],
    role,
    dependsOn: [...new Set(value.dependsOn)],
    priority: Math.trunc(value.priority),
    requiresWorktree: value.requiresWorktree,
    status: value.status as WorkflowTaskStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    generation: value.generation,
    ...(typeof value.leadAgentId === "string"
      ? { leadAgentId: value.leadAgentId }
      : {}),
    ...(typeof value.parentTaskId === "string"
      ? { parentTaskId: value.parentTaskId }
      : {}),
    ...(typeof value.blockedReason === "string"
      ? { blockedReason: value.blockedReason }
      : {}),
    ...(typeof value.errorText === "string"
      ? { errorText: value.errorText }
      : {}),
  };
}

function parseEvent(value: unknown): LedgerEventRecord {
  if (
    !isRecord(value) ||
    typeof value.sequence !== "number" ||
    !isRecord(value.event)
  )
    throw new Error("Malformed task ledger event.");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1)
    throw new Error("Malformed task ledger event sequence.");
  return {
    sequence: value.sequence,
    event: parseLeadAgentEvent(value.event),
    ...(typeof value.acknowledgedAt === "number"
      ? { acknowledgedAt: value.acknowledgedAt }
      : {}),
  };
}

export class TaskLedger {
  readonly filePath: string;
  private readonly tasks = new Map<string, LedgerTask>();
  private readonly events: LedgerEventRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private nextSequence = 1;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "task-ledger.json");
  }

  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot read task ledger: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Task ledger is malformed JSON; refusing replay.");
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.tasks) ||
      !Array.isArray(parsed.events) ||
      typeof parsed.nextSequence !== "number" ||
      !Number.isSafeInteger(parsed.nextSequence) ||
      parsed.nextSequence < 1
    ) {
      throw new Error("Task ledger has an unsupported schema.");
    }
    this.tasks.clear();
    this.events.length = 0;
    const sequences = new Set<number>();
    const eventIds = new Set<string>();
    for (const value of parsed.tasks) {
      const task = parseTask(value);
      if (this.tasks.has(task.id))
        throw new Error(`Duplicate task ledger task: ${task.id}`);
      this.tasks.set(task.id, task);
    }
    for (const value of parsed.events) {
      const record = parseEvent(value);
      if (sequences.has(record.sequence))
        throw new Error(
          `Duplicate task ledger event sequence: ${record.sequence}`,
        );
      if (eventIds.has(record.event.eventId))
        throw new Error(
          `Duplicate task ledger event id: ${record.event.eventId}`,
        );
      sequences.add(record.sequence);
      eventIds.add(record.event.eventId);
      this.events.push(record);
    }
    const highestSequence = Math.max(0, ...sequences);
    if (parsed.nextSequence <= highestSequence)
      throw new Error(
        "Task ledger next sequence is not ahead of stored events.",
      );
    this.nextSequence = parsed.nextSequence;
  }

  get(taskId: WorkflowTaskId): LedgerTask | undefined {
    return this.tasks.get(taskId);
  }
  list(): ReadonlyArray<LedgerTask> {
    return [...this.tasks.values()].sort(
      (a, b) =>
        b.priority - a.priority ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  }
  eventsList(): ReadonlyArray<LedgerEventRecord> {
    return this.events.map((item) => ({ ...item, event: { ...item.event } }));
  }
  pendingEvents(): ReadonlyArray<LedgerEventRecord> {
    return this.events
      .filter((item) => item.acknowledgedAt === undefined)
      .map((item) => ({ ...item, event: { ...item.event } }));
  }

  async ensure(input: LedgerTaskInput): Promise<LedgerTask> {
    const existing = this.tasks.get(input.id);
    if (existing) return existing;
    const task: LedgerTask = {
      ...createWorkflowTask(input),
      generation: 1,
      ...(input.leadAgentId === undefined
        ? {}
        : { leadAgentId: input.leadAgentId }),
      ...(input.parentTaskId === undefined
        ? {}
        : { parentTaskId: input.parentTaskId }),
    };
    this.tasks.set(task.id, task);
    await this.save();
    return task;
  }

  async status(
    taskId: WorkflowTaskId,
    status: WorkflowTaskStatus,
    message?: string,
    generation?: number,
  ): Promise<LedgerTask> {
    const current = this.tasks.get(taskId);
    if (!current) throw new Error(`Unknown task ledger task: ${taskId}`);
    const targetGeneration = generation ?? current.generation;
    if (
      targetGeneration !== current.generation &&
      targetGeneration !== current.generation + 1
    )
      throw new Error(`Invalid task ledger generation for ${taskId}.`);
    const event: WorkflowEvent = {
      type: "status",
      status,
      at: Date.now(),
      generation: targetGeneration,
      ...(message === undefined ? {} : { message }),
    };
    const next =
      targetGeneration === current.generation + 1
        ? status === "working"
          ? {
              ...current,
              generation: targetGeneration,
              status: "working" as const,
              updatedAt: event.at,
              blockedReason: undefined,
              errorText: undefined,
            }
          : (() => {
              throw new Error(
                `New task ledger generation for ${taskId} must start working.`,
              );
            })()
        : (applyWorkflowEvent(current, event) as LedgerTask);
    this.tasks.set(taskId, next);
    await this.save();
    return next;
  }

  /** Remove the record and task-scoped orchestration events for a deleted Thread. */
  async remove(taskId: WorkflowTaskId): Promise<boolean> {
    const existed = this.tasks.delete(taskId);
    let removedEvents = false;
    for (let index = this.events.length - 1; index >= 0; index--) {
      if (this.events[index]?.event.taskId === taskId) {
        this.events.splice(index, 1);
        removedEvents = true;
      }
    }
    if (existed || removedEvents) await this.save();
    return existed || removedEvents;
  }

  async append(event: LeadAgentEvent): Promise<{
    readonly record: LedgerEventRecord;
    readonly duplicate: boolean;
  }> {
    const existing = this.events.find(
      (item) => item.event.eventId === event.eventId,
    );
    if (existing)
      return {
        record: { ...existing, event: { ...existing.event } },
        duplicate: true,
      };
    const record: LedgerEventRecord = { sequence: this.nextSequence++, event };
    this.events.push(record);
    await this.save();
    return {
      record: { ...record, event: { ...record.event } },
      duplicate: false,
    };
  }

  async acknowledgeEvent(eventId: string): Promise<boolean> {
    const index = this.events.findIndex(
      (item) =>
        item.event.eventId === eventId && item.acknowledgedAt === undefined,
    );
    if (index < 0) return false;
    this.events[index] = { ...this.events[index]!, acknowledgedAt: Date.now() };
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      const state: StoredLedger = {
        version: 1,
        tasks: this.list(),
        events: this.events,
        nextSequence: this.nextSequence,
      };
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    };
    const result = this.writeChain.then(
      () => withDurableWrite(operation),
      () => withDurableWrite(operation),
    );
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
