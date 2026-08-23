import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BackendName, SpawnTask, SubagentMode } from "./domain.ts"

export type JobStatus = "queued" | "running" | "done" | "error" | "blocked"

export interface JobRecord {
  readonly id: string
  readonly title: string
  readonly backend: BackendName
  readonly mode: SubagentMode
  readonly dependsOn: ReadonlyArray<string>
  readonly priority: number
  readonly createdAt: number
  readonly status: JobStatus
  readonly errorText?: string
}

export interface QueuedJob extends JobRecord {
  readonly task: SpawnTask
}

interface StoredJob extends JobRecord {}

function bounded(value: string, max = 4_096) {
  return value.slice(0, max)
}

function compare(a: QueuedJob, b: QueuedJob) {
  return b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

export class JobQueueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JobQueueError"
  }
}

/** Dependency-aware queue for jobs that have not yet entered SubagentManager. */
export class JobQueue {
  readonly filePath: string
  private readonly records = new Map<string, QueuedJob>()
  /** Prevent late dispatch/persistence callbacks from resurrecting a deleted job. */
  private readonly deletedJobs = new Set<string>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "job-queue.json")
  }

  async restore(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new JobQueueError(`Cannot read job queue: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new JobQueueError("Job queue is malformed JSON; refusing replay.")
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { jobs?: unknown }).jobs)) {
      throw new JobQueueError("Job queue has an unsupported schema.")
    }
    for (const value of (parsed as { jobs: unknown[] }).jobs) {
      if (!value || typeof value !== "object") throw new JobQueueError("Malformed job.")
      const item = value as Partial<StoredJob>
      if (
        typeof item.id !== "string" || typeof item.title !== "string"
        || typeof item.backend !== "string" || typeof item.mode !== "string"
        || !Array.isArray(item.dependsOn) || typeof item.priority !== "number"
        || typeof item.createdAt !== "number" || typeof item.status !== "string"
      ) throw new JobQueueError("Malformed job fields.")
      if (!item.dependsOn.every((id) => typeof id === "string" && id.length > 0)) {
        throw new JobQueueError("Malformed job dependencies.")
      }
      if (this.records.has(item.id)) throw new JobQueueError(`Duplicate job: ${item.id}`)
      // Restored records do not carry executable parent context. They remain
      // visible as recovery-required until the caller re-enqueues the task.
      this.records.set(item.id, {
        id: item.id,
        title: item.title,
        backend: item.backend as BackendName,
        mode: item.mode as SubagentMode,
        dependsOn: item.dependsOn,
        priority: item.priority,
        createdAt: item.createdAt,
        // A restored queue has no executable parent context. Never dispatch a
        // placeholder task after restart; the caller must explicitly re-enqueue it.
        status: item.status === "done" || item.status === "error" ? item.status : "blocked",
        errorText: item.status === "done" || item.status === "error"
          ? (typeof item.errorText === "string" ? bounded(item.errorText) : undefined)
          : "Job requires explicit re-enqueue after restart.",
        task: {
          jobId: item.id,
          title: item.title,
          prompt: "[job restored; re-enqueue with a complete briefing]",
          cwd: "",
          mode: item.mode as SubagentMode,
          parent: { parentCwd: "", projectTrusted: false },
        },
      })
    }
  }

  async enqueue(
    job: Omit<QueuedJob, "status" | "createdAt">,
    dependencyExists: (id: string) => boolean = () => false,
  ): Promise<QueuedJob> {
    if (this.deletedJobs.has(job.id)) throw new JobQueueError(`Job was deleted: ${job.id}`)
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(job.id)) throw new JobQueueError("Invalid job id.")
    if (this.records.has(job.id)) throw new JobQueueError(`Job already exists: ${job.id}`)
    const dependsOn = [...new Set(job.dependsOn)]
    if (dependsOn.includes(job.id)) throw new JobQueueError("Job cannot depend on itself.")
    for (const dependency of dependsOn) {
      const record = this.records.get(dependency)
      if (!record && !dependencyExists(dependency)) {
        throw new JobQueueError(`Unknown job dependency: ${dependency}`)
      }
      if (record && this.dependsTransitivelyOn(record.id, job.id, new Set())) {
        throw new JobQueueError(`Job dependency cycle involving ${job.id}.`)
      }
    }
    const record: QueuedJob = {
      ...job,
      dependsOn,
      priority: Number.isFinite(job.priority) ? Math.trunc(job.priority) : 0,
      createdAt: Date.now(),
      status: "queued",
    }
    this.records.set(record.id, record)
    await this.save()
    return record
  }

  get(id: string): QueuedJob | undefined {
    return this.records.get(id)
  }

  list(): ReadonlyArray<QueuedJob> {
    return [...this.records.values()].sort(compare)
  }

  ready(isSettled: (id: string) => boolean): ReadonlyArray<QueuedJob> {
    return this.list().filter((job) => job.status === "queued" && job.dependsOn.every(isSettled))
  }

  blocked(isFailed: (id: string) => boolean): ReadonlyArray<QueuedJob> {
    return this.list().filter((job) => job.status === "queued" && job.dependsOn.some(isFailed))
  }

  async mark(id: string, status: JobStatus, errorText?: string): Promise<QueuedJob> {
    if (this.deletedJobs.has(id)) throw new JobQueueError(`Job was deleted: ${id}`)
    const current = this.records.get(id)
    if (!current) throw new JobQueueError(`Unknown job: ${id}`)
    const next: QueuedJob = {
      ...current,
      status,
      ...(errorText === undefined ? {} : { errorText: bounded(errorText) }),
    }
    this.records.set(id, next)
    await this.save()
    return next
  }

  async remove(id: string): Promise<void> {
    this.deletedJobs.add(id)
    this.records.delete(id)
    for (const [jobId, record] of this.records) {
      if (record.status === "queued" && record.dependsOn.includes(id)) {
        this.records.set(jobId, {
          ...record,
          status: "blocked",
          errorText: `Dependency ${id} was deleted.`,
        })
      }
    }
    await this.save()
  }

  private dependsTransitivelyOn(currentId: string, targetId: string, seen: Set<string>): boolean {
    if (currentId === targetId) return true
    if (seen.has(currentId)) return false
    seen.add(currentId)
    const current = this.records.get(currentId)
    return !!current?.dependsOn.some((dependency) => this.dependsTransitivelyOn(dependency, targetId, seen))
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
      const jobs: StoredJob[] = this.list().map(({ task: _task, ...record }) => record)
      await writeFile(temporary, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, "utf8")
      await rename(temporary, this.filePath)
    }
    const result = this.writeChain.then(operation, operation)
    this.writeChain = result.then(() => undefined, () => undefined)
    return result
  }
}
