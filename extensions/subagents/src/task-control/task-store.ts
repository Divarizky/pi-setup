import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TaskRecord, type TaskStatus, transitionTask } from "./task-state.js";

export interface TaskEvent {
  taskId: string;
  previousStatus?: TaskStatus;
  nextStatus: TaskStatus;
  reason: string;
  timestamp: number;
}

export interface TaskSnapshot {
  version: 1;
  tasks: Record<string, TaskRecord>;
}

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "running",
  "completed",
  "completed_no_changes",
  "failed",
  "interrupted",
  "candidate_ready",
  "validation_failed",
  "recovery_required",
  "rejected",
  "integrating",
  "integration_conflict",
  "integrated",
  "integrated_unrecorded",
]);

function isTaskRecord(task: unknown): task is TaskRecord {
  if (!task || typeof task !== "object") return false;
  const record = task as Partial<TaskRecord>;
  return typeof record.id === "string"
    && typeof record.objective === "string"
    && typeof record.repositoryPath === "string"
    && typeof record.createdAt === "number"
    && typeof record.updatedAt === "number"
    && typeof record.status === "string"
    && TASK_STATUSES.has(record.status);
}

export class TaskStore {
  private readonly directory: string;
  private readonly statePath: string;
  private readonly eventsPath: string;
  private readonly clock: () => number;

  constructor(gitCommonDir: string, clock: () => number = Date.now) {
    this.directory = join(gitCommonDir, "agent-control");
    this.statePath = join(this.directory, "state.json");
    this.eventsPath = join(this.directory, "events.jsonl");
    this.clock = clock;
  }

  load(): TaskSnapshot {
    if (!existsSync(this.statePath)) return { version: 1, tasks: {} };

    let parsed: Partial<TaskSnapshot>;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as Partial<TaskSnapshot>;
    } catch (error) {
      throw new Error(`Invalid Agent Control task snapshot: ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.version !== 1 || !parsed.tasks || typeof parsed.tasks !== "object") {
      throw new Error(`Invalid Agent Control task snapshot: ${this.statePath}`);
    }
    const tasks: Record<string, TaskRecord> = {};
    for (const [taskId, task] of Object.entries(parsed.tasks)) {
      if (isTaskRecord(task)) tasks[taskId] = task;
    }
    return { version: 1, tasks };
  }

  readEvents(): TaskEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const events: TaskEvent[] = [];
    for (const line of readFileSync(this.eventsPath, "utf-8").split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line) as TaskEvent;
        if (typeof event.taskId !== "string" || typeof event.nextStatus !== "string" || typeof event.timestamp !== "number") continue;
        events.push({
          taskId: event.taskId,
          previousStatus: event.previousStatus,
          nextStatus: event.nextStatus,
          reason: typeof event.reason === "string" ? event.reason : "",
          timestamp: event.timestamp,
        });
      } catch {
        // Skip a single corrupt audit line; the snapshot stays authoritative.
      }
    }
    return events;
  }

  createTask(task: TaskRecord): void {
    const snapshot = this.load();
    if (snapshot.tasks[task.id]) throw new Error(`Task already exists: ${task.id}`);

    const next = {
      version: 1 as const,
      tasks: { ...snapshot.tasks, [task.id]: task },
    };
    this.commit(next, {
      taskId: task.id,
      previousStatus: undefined,
      nextStatus: task.status,
      reason: "task created",
      timestamp: this.clock(),
    });
  }

  transition(taskId: string, nextStatus: TaskStatus, reason: string): TaskRecord {
    const snapshot = this.load();
    const current = snapshot.tasks[taskId];
    if (!current) throw new Error(`Task not found: ${taskId}`);

    const next = transitionTask(current, nextStatus, reason, this.clock());
    this.commit(
      { version: 1, tasks: { ...snapshot.tasks, [taskId]: next } },
      {
        taskId,
        previousStatus: current.status,
        nextStatus,
        reason,
        timestamp: next.updatedAt,
      },
    );
    return next;
  }

  /** Persist a lifecycle transition and related metadata in one snapshot/event pair. */
  transitionWithPatch(
    taskId: string,
    nextStatus: TaskStatus,
    reason: string,
    patch: Partial<Omit<TaskRecord, "id" | "createdAt" | "status">>,
  ): TaskRecord {
    const snapshot = this.load();
    const current = snapshot.tasks[taskId];
    if (!current) throw new Error(`Task not found: ${taskId}`);

    const transitioned = transitionTask(current, nextStatus, reason, this.clock());
    const next: TaskRecord = { ...transitioned, ...patch, id: current.id, createdAt: current.createdAt, status: nextStatus };
    this.commit(
      { version: 1, tasks: { ...snapshot.tasks, [taskId]: next } },
      {
        taskId,
        previousStatus: current.status,
        nextStatus,
        reason,
        timestamp: next.updatedAt,
      },
    );
    return next;
  }

  /**
   * Persist delivery metadata alongside an audit event. Approvals and other
   * sensitive metadata must stay auditable, so every update emits an event
   * whose nextStatus equals the current status.
   */
  updateTask(taskId: string, patch: Partial<Omit<TaskRecord, "id" | "createdAt" | "status">>, reason = "task metadata updated"): TaskRecord {
    const snapshot = this.load();
    const current = snapshot.tasks[taskId];
    if (!current) throw new Error(`Task not found: ${taskId}`);

    const next: TaskRecord = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      status: current.status,
      updatedAt: this.clock(),
    };
    this.commit({ version: 1, tasks: { ...snapshot.tasks, [taskId]: next } }, {
      taskId,
      previousStatus: current.status,
      nextStatus: current.status,
      reason,
      timestamp: next.updatedAt,
    });
    return next;
  }

  private commit(snapshot: TaskSnapshot, event?: TaskEvent): void {
    mkdirSync(this.directory, { recursive: true });
    // Best-effort inter-process mutual exclusion: an exclusive lock file
    // serializes concurrent writers (completion handler, recovery, UI).
    // State is renamed before the event is appended so a crash can never
    // leave an event without its matching snapshot.
    const lockPath = `${this.statePath}.lock`;
    const lockFd = this.acquireLock(lockPath);
    const tempPath = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
      renameSync(tempPath, this.statePath);
      if (event) appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (error) {
      try { rmSync(tempPath, { force: true }); } catch { /* preserve the last valid snapshot */ }
      throw error;
    } finally {
      this.releaseLock(lockPath, lockFd);
    }
  }

  private acquireLock(lockPath: string): number | undefined {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const fd = openSync(lockPath, "wx");
        try { writeSync(fd, String(process.pid)); } catch { /* pid hint is best effort */ }
        return fd;
      } catch {
        // Lock held by another writer; spin briefly then proceed best-effort.
        const start = Date.now();
        while (Date.now() - start < 25) { /* busy-wait, keeps commit synchronous */ }
      }
    }
    return undefined;
  }

  private releaseLock(lockPath: string, lockFd: number | undefined): void {
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { /* lock release is best effort */ }
      try { rmSync(lockPath, { force: true }); } catch { /* lock file is best effort */ }
    }
  }
}

/** Resolve the repository's common Git directory without shell interpolation. */
export async function resolveTaskStore(
  pi: ExtensionAPI,
  cwd: string,
): Promise<TaskStore | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 5000 });
  if (result.killed || result.code !== 0) return undefined;
  const raw = result.stdout.trim();
  if (!raw) return undefined;
  const commonDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return new TaskStore(commonDir);
}
