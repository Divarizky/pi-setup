import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BackendName,
  LeadAgentId,
  SubagentJobId,
  SubagentMode,
} from "./domain.ts";

const VERSION = 1;
const MAX_TEXT = 32_000;

export interface LeadAgentRecord {
  readonly leadAgentId: LeadAgentId;
  readonly jobId: SubagentJobId;
  readonly title: string;
  readonly backend: BackendName;
  readonly mode: SubagentMode;
  readonly charter?: string;
  readonly scope?: string;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly repoRoot?: string;
  readonly sessionFilePath?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSummary?: string;
}

export class LeadAgentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadAgentStoreError";
  }
}

function bounded(value: string, max = MAX_TEXT) {
  return value.slice(0, max);
}

function sanitizeSummary(value: string) {
  return bounded(value, 4_096)
    .replace(
      /(token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@");
}

function validId(value: string) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function parseRecord(value: unknown): LeadAgentRecord {
  if (!value || typeof value !== "object")
    throw new LeadAgentStoreError("Malformed lead agent record.");
  const item = value as Partial<LeadAgentRecord>;
  if (
    typeof item.leadAgentId !== "string" ||
    !validId(item.leadAgentId) ||
    typeof item.jobId !== "string" ||
    !validId(item.jobId) ||
    typeof item.title !== "string" ||
    typeof item.cwd !== "string" ||
    typeof item.backend !== "string" ||
    (item.mode !== "scout" && item.mode !== "build") ||
    typeof item.createdAt !== "number" ||
    typeof item.updatedAt !== "number"
  )
    throw new LeadAgentStoreError("Malformed lead agent record fields.");
  return {
    leadAgentId: item.leadAgentId,
    jobId: item.jobId,
    title: bounded(item.title, 160),
    backend: item.backend as BackendName,
    mode: item.mode,
    ...(typeof item.charter === "string"
      ? { charter: sanitizeSummary(item.charter) }
      : {}),
    ...(typeof item.scope === "string"
      ? { scope: sanitizeSummary(item.scope) }
      : {}),
    cwd: bounded(item.cwd, 4_096),
    ...(typeof item.worktreePath === "string"
      ? { worktreePath: bounded(item.worktreePath, 4_096) }
      : {}),
    ...(typeof item.branch === "string"
      ? { branch: bounded(item.branch, 512) }
      : {}),
    ...(typeof item.repoRoot === "string"
      ? { repoRoot: bounded(item.repoRoot, 4_096) }
      : {}),
    ...(typeof item.sessionFilePath === "string"
      ? { sessionFilePath: bounded(item.sessionFilePath, 4_096) }
      : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(typeof item.lastSummary === "string"
      ? { lastSummary: sanitizeSummary(item.lastSummary) }
      : {}),
  };
}

export class LeadAgentStore {
  readonly filePath: string;
  private readonly legacyFilePath: string;
  private readonly records = new Map<string, LeadAgentRecord>();
  private readonly deletedJobs = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "lead-agents.json");
    this.legacyFilePath = path.join(rootDir, "resident-subagents.json");
  }

  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LeadAgentStoreError(
          `Cannot read lead agent state: ${String(error)}`,
        );
      }
      try {
        raw = await readFile(this.legacyFilePath, "utf8");
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new LeadAgentStoreError(
          `Cannot read legacy lead agent state: ${String(legacyError)}`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LeadAgentStoreError(
        "Lead agent state is malformed JSON; refusing replay.",
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== VERSION
    ) {
      throw new LeadAgentStoreError(
        "Lead agent state has an unsupported schema.",
      );
    }
    const state = parsed as { leadAgents?: unknown[]; residents?: unknown[] };
    const values =
      state.leadAgents ??
      state.residents?.map((value) => {
        if (!value || typeof value !== "object") return value;
        const item = value as Record<string, unknown>;
        return { ...item, leadAgentId: item.leadAgentId ?? item.residentId };
      });
    if (!values)
      throw new LeadAgentStoreError(
        "Lead agent state has an unsupported schema.",
      );
    for (const value of values) {
      const record = parseRecord(value);
      if (this.records.has(record.leadAgentId))
        throw new LeadAgentStoreError(
          `Duplicate lead agent: ${record.leadAgentId}`,
        );
      this.records.set(record.leadAgentId, record);
    }
  }

  get(leadAgentId: string) {
    return this.records.get(leadAgentId);
  }

  list() {
    return [...this.records.values()].sort((a, b) =>
      a.leadAgentId.localeCompare(b.leadAgentId),
    );
  }

  async create(record: Omit<LeadAgentRecord, "createdAt" | "updatedAt">) {
    if (this.deletedJobs.has(record.jobId))
      throw new LeadAgentStoreError(`Job was deleted: ${record.jobId}`);
    if (!validId(record.leadAgentId))
      throw new LeadAgentStoreError("Invalid lead agent id.");
    if (this.records.has(record.leadAgentId))
      throw new LeadAgentStoreError(
        `Lead agent already exists: ${record.leadAgentId}`,
      );
    const now = Date.now();
    const next = {
      ...record,
      ...(record.charter === undefined
        ? {}
        : { charter: sanitizeSummary(record.charter) }),
      ...(record.scope === undefined
        ? {}
        : { scope: sanitizeSummary(record.scope) }),
      createdAt: now,
      updatedAt: now,
      ...(record.lastSummary === undefined
        ? {}
        : { lastSummary: sanitizeSummary(record.lastSummary) }),
    };
    this.records.set(next.leadAgentId, next);
    await this.save();
    return next;
  }

  async update(
    leadAgentId: string,
    patch: Partial<Omit<LeadAgentRecord, "leadAgentId" | "createdAt">>,
  ) {
    const current = this.records.get(leadAgentId);
    if (!current)
      throw new LeadAgentStoreError(`Unknown lead agent: ${leadAgentId}`);
    if (
      this.deletedJobs.has(current.jobId) ||
      (patch.jobId !== undefined && this.deletedJobs.has(patch.jobId))
    ) {
      throw new LeadAgentStoreError(`Job was deleted: ${current.jobId}`);
    }
    const next: LeadAgentRecord = {
      ...current,
      ...patch,
      ...(patch.title === undefined
        ? {}
        : { title: bounded(patch.title, 160) }),
      ...(patch.charter === undefined
        ? {}
        : { charter: sanitizeSummary(patch.charter) }),
      ...(patch.scope === undefined
        ? {}
        : { scope: sanitizeSummary(patch.scope) }),
      ...(patch.lastSummary === undefined
        ? {}
        : { lastSummary: sanitizeSummary(patch.lastSummary) }),
      updatedAt: Date.now(),
    };
    this.records.set(leadAgentId, next);
    await this.save();
    return next;
  }

  async remove(leadAgentId: string) {
    this.records.delete(leadAgentId);
    await this.save();
  }

  async removeByJobId(jobId: string) {
    this.deletedJobs.add(jobId);
    for (const [leadAgentId, leadAgent] of this.records) {
      if (leadAgent.jobId === jobId) this.records.delete(leadAgentId);
    }
    await this.save();
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: VERSION, leadAgents: this.list() }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, this.filePath);
    };
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
