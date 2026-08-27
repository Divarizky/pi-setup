import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BackendName, SubagentJobId, SubagentMode } from "./domain.ts";
import type { SubagentWorktree } from "./worktree.ts";
import { withDurableWrite } from "./durable-write.ts";

const VERSION = 1;

export interface ProvisioningRecord {
  readonly jobId: SubagentJobId;
  readonly backend: BackendName;
  readonly mode: SubagentMode;
  readonly title: string;
  readonly sourceCwd: string;
  readonly branchName?: string;
  readonly createdAt: number;
  readonly worktree?: SubagentWorktree;
  readonly nativeWorktreeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse(value: unknown): ProvisioningRecord {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    typeof value.backend !== "string" ||
    (value.backend !== "pi" && value.backend !== "orca") ||
    typeof value.mode !== "string" ||
    (value.mode !== "scout" && value.mode !== "build") ||
    typeof value.title !== "string" ||
    typeof value.sourceCwd !== "string" ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    throw new Error("Malformed provisioning record.");
  }
  let worktree: SubagentWorktree | undefined;
  if (value.worktree !== undefined) {
    if (
      !isRecord(value.worktree) ||
      typeof value.worktree.jobId !== "string" ||
      typeof value.worktree.repoRoot !== "string" ||
      typeof value.worktree.path !== "string" ||
      typeof value.worktree.branch !== "string"
    ) {
      throw new Error("Malformed provisioning worktree.");
    }
    worktree = {
      jobId: value.worktree.jobId,
      repoRoot: value.worktree.repoRoot,
      path: value.worktree.path,
      branch: value.worktree.branch,
    };
  }
  return {
    jobId: value.jobId,
    backend: value.backend,
    mode: value.mode,
    title: value.title,
    sourceCwd: value.sourceCwd,
    ...(typeof value.branchName === "string"
      ? { branchName: value.branchName }
      : {}),
    createdAt: value.createdAt,
    ...(worktree === undefined ? {} : { worktree }),
    ...(typeof value.nativeWorktreeId === "string"
      ? { nativeWorktreeId: value.nativeWorktreeId }
      : {}),
  };
}

/** Durable intent recorded before creating an external worktree. */
export class ProvisioningStore {
  readonly filePath: string;
  private readonly records = new Map<string, ProvisioningRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "provisioning.json");
  }

  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot read provisioning state: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Provisioning state is malformed JSON; refusing replay.");
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== VERSION ||
      !Array.isArray(parsed.records)
    ) {
      throw new Error("Provisioning state has an unsupported schema.");
    }
    this.records.clear();
    for (const value of parsed.records) {
      const record = parse(value);
      if (this.records.has(record.jobId))
        throw new Error(`Duplicate provisioning record: ${record.jobId}`);
      this.records.set(record.jobId, record);
    }
  }

  list(): ReadonlyArray<ProvisioningRecord> {
    return [...this.records.values()];
  }

  get(jobId: SubagentJobId): ProvisioningRecord | undefined {
    return this.records.get(jobId);
  }

  async begin(
    record: Omit<
      ProvisioningRecord,
      "createdAt" | "worktree" | "nativeWorktreeId"
    >,
  ): Promise<ProvisioningRecord> {
    const existing = this.records.get(record.jobId);
    if (existing) return existing;
    const next: ProvisioningRecord = { ...record, createdAt: Date.now() };
    this.records.set(record.jobId, next);
    await this.save();
    return next;
  }

  async update(
    jobId: SubagentJobId,
    patch: Pick<ProvisioningRecord, "worktree" | "nativeWorktreeId">,
  ): Promise<ProvisioningRecord> {
    const current = this.records.get(jobId);
    if (!current) throw new Error(`Unknown provisioning record: ${jobId}`);
    const next = { ...current, ...patch };
    this.records.set(jobId, next);
    await this.save();
    return next;
  }

  async remove(jobId: SubagentJobId): Promise<void> {
    if (!this.records.delete(jobId)) return;
    await this.save();
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: VERSION, records: this.list() }, null, 2)}\n`,
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
