/** Small durable store for restart-safe subagent job metadata. */

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ApprovalRequest } from "./approval.ts";
import {
  BACKEND_NAMES,
  type BackendName,
  type SubagentJobId,
  type SubagentMode,
  type SubagentOrigin,
  type SubagentReport,
  type SubagentRole,
  type SubagentStatus,
} from "./domain.ts";
import { parseStructuredReport } from "./report.ts";
import { withDurableWrite } from "./durable-write.ts";

const VERSION = 1;
const MAX_ERROR_BYTES = 4096;
const MAX_FINAL_TEXT_BYTES = 1_024 * 1_024;

export interface PersistedJob {
  readonly jobId: SubagentJobId;
  readonly origin?: SubagentOrigin;
  readonly backend?: BackendName;
  readonly role?: SubagentRole;
  readonly sessionFilePath?: string;
  readonly nativeSessionId?: string;
  readonly nativeTerminalHandle?: string;
  readonly nativeWorktreeId?: string;
  readonly nativeTabId?: string;
  readonly nativePaneKey?: string;
  readonly nativeLaunchToken?: string;
  readonly title: string;
  readonly mode: SubagentMode;
  readonly cwd: string;
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly repoRoot?: string;
  readonly errorText?: string;
  readonly report?: SubagentReport;
  readonly finalText?: string;
}

export interface JobEvent {
  readonly at: number;
  readonly jobId: SubagentJobId;
  readonly event: string;
  readonly message?: string;
}

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJob(value: unknown): PersistedJob {
  if (!isRecord(value)) throw new PersistenceError("Malformed persisted job.");
  const requiredStrings = ["jobId", "title", "cwd"];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new PersistenceError(`Malformed persisted job field: ${key}.`);
    }
  }
  if (value.mode !== "scout" && value.mode !== "build") {
    throw new PersistenceError("Malformed persisted job mode.");
  }
  if (
    value.status !== "running" &&
    value.status !== "done" &&
    value.status !== "failed" &&
    value.status !== "error"
  ) {
    throw new PersistenceError("Malformed persisted job status.");
  }
  if (
    value.origin !== undefined &&
    value.origin !== "model" &&
    value.origin !== "quick-ask"
  ) {
    throw new PersistenceError("Malformed persisted job origin.");
  }
  if (
    value.role !== undefined &&
    value.role !== "worker" &&
    value.role !== "lead"
  ) {
    throw new PersistenceError("Malformed persisted job role.");
  }
  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    throw new PersistenceError("Malformed persisted job timestamp.");
  }
  if (
    value.backend !== undefined &&
    !BACKEND_NAMES.includes(value.backend as BackendName)
  ) {
    throw new PersistenceError("Malformed persisted job backend.");
  }
  const jobId = value.jobId as string;
  const origin = value.origin as SubagentOrigin | undefined;
  const backend = value.backend as BackendName | undefined;
  const role = value.role as SubagentRole | undefined;
  const sessionFilePath =
    typeof value.sessionFilePath === "string"
      ? value.sessionFilePath.slice(0, 4_096)
      : undefined;
  const nativeSessionId =
    typeof value.nativeSessionId === "string"
      ? value.nativeSessionId.slice(0, 512)
      : undefined;
  const nativeTerminalHandle =
    typeof value.nativeTerminalHandle === "string"
      ? value.nativeTerminalHandle.slice(0, 512)
      : undefined;
  const nativeWorktreeId =
    typeof value.nativeWorktreeId === "string"
      ? value.nativeWorktreeId.slice(0, 512)
      : undefined;
  const nativeTabId =
    typeof value.nativeTabId === "string"
      ? value.nativeTabId.slice(0, 512)
      : undefined;
  const nativePaneKey =
    typeof value.nativePaneKey === "string"
      ? value.nativePaneKey.slice(0, 512)
      : undefined;
  const nativeLaunchToken =
    typeof value.nativeLaunchToken === "string"
      ? value.nativeLaunchToken.slice(0, 512)
      : undefined;
  const title = value.title as string;
  const cwd = value.cwd as string;
  const settledAt =
    typeof value.settledAt === "number" ? value.settledAt : undefined;
  const worktreePath =
    typeof value.worktreePath === "string" ? value.worktreePath : undefined;
  const branch = typeof value.branch === "string" ? value.branch : undefined;
  const repoRoot =
    typeof value.repoRoot === "string" ? value.repoRoot : undefined;
  const errorText =
    typeof value.errorText === "string"
      ? value.errorText.slice(0, MAX_ERROR_BYTES)
      : undefined;
  let report: SubagentReport | undefined;
  if (value.report !== undefined) {
    const encoded = JSON.stringify(value.report);
    report =
      typeof encoded === "string"
        ? parseStructuredReport(`<subagent-report>${encoded}</subagent-report>`)
        : undefined;
    if (!report)
      throw new PersistenceError("Malformed persisted subagent report.");
  }
  const finalText =
    typeof value.finalText === "string"
      ? value.finalText.slice(0, MAX_FINAL_TEXT_BYTES)
      : undefined;
  return {
    jobId,
    ...(origin === undefined ? {} : { origin }),
    ...(backend === undefined ? {} : { backend }),
    ...(role === undefined ? {} : { role }),
    ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(nativeTerminalHandle === undefined ? {} : { nativeTerminalHandle }),
    ...(nativeWorktreeId === undefined ? {} : { nativeWorktreeId }),
    ...(nativeTabId === undefined ? {} : { nativeTabId }),
    ...(nativePaneKey === undefined ? {} : { nativePaneKey }),
    ...(nativeLaunchToken === undefined ? {} : { nativeLaunchToken }),
    title,
    mode: value.mode,
    cwd,
    status: value.status === "error" ? "failed" : value.status,
    createdAt: value.createdAt,
    ...(settledAt === undefined ? {} : { settledAt }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(branch === undefined ? {} : { branch }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(errorText === undefined ? {} : { errorText }),
    ...(report === undefined ? {} : { report }),
    ...(finalText === undefined ? {} : { finalText }),
  };
}

export class JobPersistence {
  readonly statePath: string;
  readonly eventsPath: string;
  readonly approvalsPath: string;

  readonly rootDir: string;
  private writeChain: Promise<void> = Promise.resolve();
  /** Job ids explicitly deleted in this runtime must never be recreated by a late callback. */
  private readonly deletedJobs = new Set<string>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, "jobs.json");
    this.eventsPath = path.join(rootDir, "events.jsonl");
    this.approvalsPath = path.join(rootDir, "approvals.json");
  }

  async loadApprovals(): Promise<ReadonlyArray<ApprovalRequest>> {
    let raw: string;
    try {
      raw = await readFile(this.approvalsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PersistenceError(
        `Cannot read durable approval state: ${String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PersistenceError(
        "Durable approval state is malformed JSON; refusing to overwrite it.",
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== VERSION ||
      !Array.isArray(parsed.approvals)
    ) {
      throw new PersistenceError(
        "Durable approval state has an unsupported schema.",
      );
    }
    const seen = new Set<string>();
    return parsed.approvals.map((value) => {
      if (!isRecord(value))
        throw new PersistenceError("Malformed persisted approval.");
      const strings = ["id", "jobId", "operation", "status"];
      for (const key of strings) {
        if (typeof value[key] !== "string" || value[key].length === 0) {
          throw new PersistenceError(
            `Malformed persisted approval field: ${key}.`,
          );
        }
      }
      if (
        ![
          "review",
          "commit",
          "merge",
          "push",
          "pr",
          "delete-worktree",
        ].includes(value.operation as string)
      ) {
        throw new PersistenceError("Malformed persisted approval operation.");
      }
      if (
        !["pending", "approved", "executing", "rejected", "consumed"].includes(
          value.status as string,
        )
      ) {
        throw new PersistenceError("Malformed persisted approval status.");
      }
      const id = value.id as string;
      if (seen.has(id))
        throw new PersistenceError(`Duplicate persisted approval: ${id}`);
      seen.add(id);
      if (
        typeof value.requestedAt !== "number" ||
        !Number.isFinite(value.requestedAt)
      ) {
        throw new PersistenceError("Malformed persisted approval timestamp.");
      }
      if (
        value.status !== "pending" &&
        (value.decidedBy !== "human" ||
          typeof value.decidedAt !== "number" ||
          !Number.isFinite(value.decidedAt))
      ) {
        throw new PersistenceError(
          "Persisted approval lacks verified human decision evidence.",
        );
      }
      return {
        id,
        jobId: value.jobId as string,
        operation: value.operation as ApprovalRequest["operation"],
        status: value.status as ApprovalRequest["status"],
        requestedAt: value.requestedAt,
        ...(typeof value.decidedAt === "number"
          ? { decidedAt: value.decidedAt }
          : {}),
        ...(value.decidedBy === "human" ? { decidedBy: "human" as const } : {}),
        ...(typeof value.reason === "string"
          ? { reason: value.reason.slice(0, MAX_ERROR_BYTES) }
          : {}),
      };
    });
  }

  async saveApprovals(
    approvals: ReadonlyArray<ApprovalRequest>,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const temporaryPath = `${this.approvalsPath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: VERSION, approvals }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.approvalsPath);
    });
  }

  async load(): Promise<ReadonlyArray<PersistedJob>> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PersistenceError(
        `Cannot read durable job state: ${String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PersistenceError(
        "Durable job state is malformed JSON; refusing to overwrite it.",
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== VERSION ||
      !Array.isArray(parsed.jobs)
    ) {
      throw new PersistenceError(
        "Durable job state has an unsupported schema.",
      );
    }
    return parsed.jobs.map(parseJob);
  }

  async upsert(job: PersistedJob): Promise<void> {
    if (this.deletedJobs.has(job.jobId)) return;
    return this.enqueueWrite(async () => {
      if (this.deletedJobs.has(job.jobId)) return;
      const jobs = [...(await this.load())];
      const index = jobs.findIndex((item) => item.jobId === job.jobId);
      if (index === -1) jobs.push(job);
      else jobs[index] = job;
      await this.writeState(jobs);
    });
  }

  async appendEvent(event: JobEvent): Promise<void> {
    if (this.deletedJobs.has(event.jobId)) return;
    return this.enqueueWrite(async () => {
      if (this.deletedJobs.has(event.jobId)) return;
      await mkdir(this.rootDir, { recursive: true });
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async deleteJob(jobId: string): Promise<void> {
    this.deletedJobs.add(jobId);
    return this.enqueueWrite(async () => {
      const jobs = (await this.load()).filter((job) => job.jobId !== jobId);
      await this.writeState(jobs);
      const events = await this.loadEvents();
      const remaining = events.filter((event) => event.jobId !== jobId);
      await mkdir(this.rootDir, { recursive: true });
      const temporaryPath = `${this.eventsPath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(
        temporaryPath,
        remaining.map((event) => JSON.stringify(event)).join("\n") +
          (remaining.length > 0 ? "\n" : ""),
        "utf8",
      );
      await rename(temporaryPath, this.eventsPath);
    });
  }

  async loadEvents(): Promise<ReadonlyArray<JobEvent>> {
    let raw: string;
    try {
      raw = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PersistenceError(
        `Cannot read durable job events: ${String(error)}`,
      );
    }
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new PersistenceError(
            "Durable job event log is malformed JSON; refusing replay.",
          );
        }
        if (
          !isRecord(value) ||
          typeof value.jobId !== "string" ||
          typeof value.event !== "string" ||
          typeof value.at !== "number"
        ) {
          throw new PersistenceError(
            "Durable job event has an invalid schema; refusing replay.",
          );
        }
        return {
          at: value.at,
          jobId: value.jobId,
          event: value.event,
          ...(typeof value.message === "string"
            ? { message: value.message.slice(0, MAX_ERROR_BYTES) }
            : {}),
        };
      });
  }

  private async writeState(jobs: ReadonlyArray<PersistedJob>): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: VERSION, jobs }, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.statePath);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
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
