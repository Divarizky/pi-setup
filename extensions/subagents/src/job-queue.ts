import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  SUBAGENT_MODES,
  type BackendName,
  type ParentContext,
  type SubagentJobId,
  type SpawnTask,
  type SubagentInitialTerminal,
  type SubagentMode,
  type SubagentRole,
} from "./domain.ts";
import type { SubagentWorktree } from "./worktree.ts";
import { withDurableWrite } from "./durable-write.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "blocked";

type StoredParentContext = Omit<ParentContext, "modelRegistry">;
type StoredTask = Omit<SpawnTask, "parent"> & {
  readonly parent: StoredParentContext;
};

export interface JobRecord {
  /** Public queue field retained for compatibility; always a SubagentJobId. */
  readonly id: SubagentJobId;
  readonly title: string;
  readonly backend: BackendName;
  readonly mode: SubagentMode;
  readonly dependsOn: ReadonlyArray<string>;
  readonly priority: number;
  readonly createdAt: number;
  readonly status: JobStatus;
  readonly errorText?: string;
}

export interface QueuedJob extends JobRecord {
  readonly task: SpawnTask;
}

interface StoredJob extends JobRecord {
  readonly task?: StoredTask;
}

function bounded(value: string, max = 4_096) {
  return value.slice(0, max);
}

function serializeTask(task: SpawnTask): StoredTask {
  const { parent, ...rest } = task;
  return {
    ...rest,
    prompt: bounded(task.prompt, 32_000),
    title: bounded(task.title, 160),
    cwd: bounded(task.cwd),
    parent: {
      parentCwd: bounded(parent.parentCwd),
      projectTrusted: parent.projectTrusted,
      ...(parent.inheritedModel === undefined
        ? {}
        : { inheritedModel: parent.inheritedModel }),
      ...(parent.inheritedThinkingLevel === undefined
        ? {}
        : { inheritedThinkingLevel: parent.inheritedThinkingLevel }),
      ...(parent.parentStateRoot === undefined
        ? {}
        : { parentStateRoot: bounded(parent.parentStateRoot) }),
    },
  };
}

function restoredTask(
  value: unknown,
  id: string,
  title: string,
  mode: SubagentMode,
): SpawnTask {
  if (!value || typeof value !== "object") {
    return {
      jobId: id,
      title,
      prompt: "",
      cwd: "",
      mode,
      parent: { parentCwd: "", projectTrusted: false },
    };
  }
  const item = value as Partial<StoredTask> & {
    parent?: Partial<StoredParentContext>;
  };
  if (
    typeof item.prompt !== "string" ||
    typeof item.title !== "string" ||
    typeof item.cwd !== "string"
  ) {
    throw new JobQueueError(`Malformed task for job: ${id}`);
  }
  if (
    item.mode !== undefined &&
    !SUBAGENT_MODES.includes(item.mode as SubagentMode)
  ) {
    throw new JobQueueError(`Malformed task mode for job: ${id}`);
  }
  if (
    item.origin !== undefined &&
    item.origin !== "model" &&
    item.origin !== "quick-ask"
  ) {
    throw new JobQueueError(`Malformed task origin for job: ${id}`);
  }
  if (
    item.reasoningEffort !== undefined &&
    !REASONING_EFFORTS.includes(item.reasoningEffort)
  ) {
    throw new JobQueueError(`Malformed task reasoning effort for job: ${id}`);
  }
  if (
    item.role !== undefined &&
    item.role !== "worker" &&
    item.role !== "lead"
  ) {
    throw new JobQueueError(`Malformed task role for job: ${id}`);
  }
  const parent = item.parent;
  if (
    !parent ||
    typeof parent.parentCwd !== "string" ||
    typeof parent.projectTrusted !== "boolean"
  ) {
    throw new JobQueueError(`Malformed task parent context for job: ${id}`);
  }
  return {
    ...(typeof item.jobId === "string" ? { jobId: item.jobId } : { jobId: id }),
    ...(typeof item.branchName === "string"
      ? { branchName: item.branchName }
      : {}),
    ...(typeof item.origin === "string"
      ? { origin: item.origin as SpawnTask["origin"] }
      : {}),
    ...(typeof item.role === "string"
      ? { role: item.role as SubagentRole }
      : {}),
    ...(typeof item.leadAgentId === "string"
      ? { leadAgentId: bounded(item.leadAgentId, 128) }
      : {}),
    prompt: bounded(item.prompt, 32_000),
    title: bounded(item.title, 160),
    cwd: bounded(item.cwd),
    ...(item.worktree === undefined
      ? {}
      : { worktree: item.worktree as SubagentWorktree }),
    ...(item.initialTerminal === undefined
      ? {}
      : { initialTerminal: item.initialTerminal as SubagentInitialTerminal }),
    mode: (item.mode as SubagentMode | undefined) ?? mode,
    ...(typeof item.model === "string"
      ? { model: bounded(item.model, 512) }
      : {}),
    ...(item.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: item.reasoningEffort }),
    ...(typeof item.timeoutMs === "number"
      ? { timeoutMs: item.timeoutMs }
      : {}),
    ...(typeof item.sessionFilePath === "string"
      ? { sessionFilePath: bounded(item.sessionFilePath) }
      : {}),
    ...(typeof item.sessionDir === "string"
      ? { sessionDir: bounded(item.sessionDir) }
      : {}),
    parent: {
      parentCwd: bounded(parent.parentCwd),
      projectTrusted: parent.projectTrusted,
      ...(parent.inheritedModel &&
      typeof parent.inheritedModel.provider === "string" &&
      typeof parent.inheritedModel.id === "string"
        ? {
            inheritedModel: {
              provider: parent.inheritedModel.provider,
              id: parent.inheritedModel.id,
            },
          }
        : {}),
      ...(parent.inheritedThinkingLevel === undefined
        ? {}
        : { inheritedThinkingLevel: parent.inheritedThinkingLevel }),
      ...(typeof parent.parentStateRoot === "string"
        ? { parentStateRoot: bounded(parent.parentStateRoot) }
        : {}),
    },
  };
}

function compare(a: QueuedJob, b: QueuedJob) {
  return (
    b.priority - a.priority ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

export class JobQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobQueueError";
  }
}

/** Dependency-aware queue for jobs that have not yet entered SubagentManager. */
export class JobQueue {
  readonly filePath: string;
  private readonly records = new Map<string, QueuedJob>();
  /** Prevent late dispatch/persistence callbacks from resurrecting a deleted job. */
  private readonly deletedJobs = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "job-queue.json");
  }

  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new JobQueueError(`Cannot read job queue: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new JobQueueError("Job queue is malformed JSON; refusing replay.");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { jobs?: unknown }).jobs)
    ) {
      throw new JobQueueError("Job queue has an unsupported schema.");
    }
    for (const value of (parsed as { jobs: unknown[] }).jobs) {
      if (!value || typeof value !== "object")
        throw new JobQueueError("Malformed job.");
      const item = value as Partial<StoredJob> & { task?: unknown };
      if (
        typeof item.id !== "string" ||
        typeof item.title !== "string" ||
        typeof item.backend !== "string" ||
        typeof item.mode !== "string" ||
        !Array.isArray(item.dependsOn) ||
        typeof item.priority !== "number" ||
        typeof item.createdAt !== "number" ||
        typeof item.status !== "string"
      )
        throw new JobQueueError("Malformed job fields.");
      if (!BACKEND_NAMES.includes(item.backend as BackendName))
        throw new JobQueueError("Malformed job backend.");
      if (!SUBAGENT_MODES.includes(item.mode as SubagentMode))
        throw new JobQueueError("Malformed job mode.");
      if (
        !["queued", "running", "done", "failed", "blocked", "error"].includes(
          item.status,
        )
      ) {
        throw new JobQueueError("Malformed job status.");
      }
      if (
        !item.dependsOn.every((id) => typeof id === "string" && id.length > 0)
      ) {
        throw new JobQueueError("Malformed job dependencies.");
      }
      if (this.records.has(item.id))
        throw new JobQueueError(`Duplicate job: ${item.id}`);
      const task = restoredTask(
        item.task,
        item.id,
        item.title,
        item.mode as SubagentMode,
      );
      const rawStatus = item.status as string;
      const status =
        rawStatus === "error" ? "failed" : (rawStatus as JobStatus);
      // Active records remain visible as recovery-required until the caller
      // explicitly re-enqueues them with the current parent context.
      this.records.set(item.id, {
        id: item.id,
        title: item.title,
        backend: item.backend as BackendName,
        mode: item.mode as SubagentMode,
        dependsOn: item.dependsOn,
        priority: item.priority,
        createdAt: item.createdAt,
        status: status === "done" || status === "failed" ? status : "blocked",
        errorText:
          status === "done" || status === "failed"
            ? typeof item.errorText === "string"
              ? bounded(item.errorText)
              : undefined
            : "Job requires explicit re-enqueue after restart.",
        task,
      });
    }
  }

  async enqueue(
    job: Omit<QueuedJob, "status" | "createdAt">,
    dependencyExists: (id: string) => boolean = () => false,
  ): Promise<QueuedJob> {
    if (this.deletedJobs.has(job.id))
      throw new JobQueueError(`Job was deleted: ${job.id}`);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(job.id))
      throw new JobQueueError("Invalid job id.");
    if (this.records.has(job.id))
      throw new JobQueueError(`Job already exists: ${job.id}`);
    const dependsOn = [...new Set(job.dependsOn)];
    if (dependsOn.includes(job.id))
      throw new JobQueueError("Job cannot depend on itself.");
    for (const dependency of dependsOn) {
      const record = this.records.get(dependency);
      if (!record && !dependencyExists(dependency)) {
        throw new JobQueueError(`Unknown job dependency: ${dependency}`);
      }
      if (record && this.dependsTransitivelyOn(record.id, job.id, new Set())) {
        throw new JobQueueError(`Job dependency cycle involving ${job.id}.`);
      }
    }
    const record: QueuedJob = {
      ...job,
      dependsOn,
      priority: Number.isFinite(job.priority) ? Math.trunc(job.priority) : 0,
      createdAt: Date.now(),
      status: "queued",
    };
    this.records.set(record.id, record);
    await this.save();
    return record;
  }

  get(jobId: SubagentJobId): QueuedJob | undefined {
    return this.records.get(jobId);
  }

  list(): ReadonlyArray<QueuedJob> {
    return [...this.records.values()].sort(compare);
  }

  ready(
    isSettled: (jobId: SubagentJobId) => boolean,
  ): ReadonlyArray<QueuedJob> {
    return this.list().filter(
      (job) => job.status === "queued" && job.dependsOn.every(isSettled),
    );
  }

  blocked(
    isFailed: (jobId: SubagentJobId) => boolean,
  ): ReadonlyArray<QueuedJob> {
    return this.list().filter(
      (job) => job.status === "queued" && job.dependsOn.some(isFailed),
    );
  }

  async mark(
    jobId: SubagentJobId,
    status: JobStatus,
    errorText?: string,
  ): Promise<QueuedJob> {
    if (this.deletedJobs.has(jobId))
      throw new JobQueueError(`Job was deleted: ${jobId}`);
    const current = this.records.get(jobId);
    if (!current) throw new JobQueueError(`Unknown job: ${jobId}`);
    const next: QueuedJob = {
      ...current,
      status,
      ...(errorText === undefined ? {} : { errorText: bounded(errorText) }),
    };
    this.records.set(jobId, next);
    await this.save();
    return next;
  }

  /** Re-queue a restored blocked job with an explicit, current executable task. */
  async requeue(jobId: SubagentJobId, task: SpawnTask): Promise<QueuedJob> {
    if (this.deletedJobs.has(jobId))
      throw new JobQueueError(`Job was deleted: ${jobId}`);
    const current = this.records.get(jobId);
    if (!current) throw new JobQueueError(`Unknown job: ${jobId}`);
    if (current.status !== "blocked")
      throw new JobQueueError(
        `Job ${jobId} is not blocked and does not need re-enqueue.`,
      );
    if (task.jobId !== jobId)
      throw new JobQueueError(
        `Re-enqueued task id does not match job: ${jobId}`,
      );
    if (task.prompt.trim().length === 0)
      throw new JobQueueError(
        `Re-enqueued task requires a complete briefing: ${jobId}`,
      );
    const next: QueuedJob = {
      ...current,
      title: bounded(task.title, 160),
      backend: current.backend,
      mode: task.mode ?? current.mode,
      status: "queued",
      errorText: undefined,
      task,
    };
    this.records.set(jobId, next);
    await this.save();
    return next;
  }

  async remove(jobId: SubagentJobId): Promise<void> {
    this.deletedJobs.add(jobId);
    this.records.delete(jobId);
    for (const [dependentJobId, record] of this.records) {
      if (record.status === "queued" && record.dependsOn.includes(jobId)) {
        this.records.set(dependentJobId, {
          ...record,
          status: "blocked",
          errorText: `Dependency ${jobId} was deleted.`,
        });
      }
    }
    await this.save();
  }

  private dependsTransitivelyOn(
    currentJobId: SubagentJobId,
    targetJobId: SubagentJobId,
    seen: Set<SubagentJobId>,
  ): boolean {
    if (currentJobId === targetJobId) return true;
    if (seen.has(currentJobId)) return false;
    seen.add(currentJobId);
    const current = this.records.get(currentJobId);
    return !!current?.dependsOn.some((dependency) =>
      this.dependsTransitivelyOn(dependency, targetJobId, seen),
    );
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      const jobs: StoredJob[] = this.list().map(({ task, ...record }) => ({
        ...record,
        task: serializeTask(task),
      }));
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`,
        "utf8",
      );
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
