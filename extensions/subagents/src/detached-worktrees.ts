import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackendName } from "./domain.ts";
import { withDurableWrite } from "./durable-write.ts";

const VERSION = 1;

export interface DetachedWorktreeRecord {
  readonly jobId: string;
  readonly title: string;
  readonly backend: BackendName;
  readonly path: string;
  readonly branch: string;
  readonly repoRoot: string;
  readonly nativeWorktreeId?: string;
  readonly leadAgentId?: string;
  readonly detachedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse(value: unknown): DetachedWorktreeRecord {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    typeof value.title !== "string" ||
    (value.backend !== "pi" && value.backend !== "orca") ||
    typeof value.path !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.repoRoot !== "string" ||
    typeof value.detachedAt !== "number"
  ) {
    throw new Error("Malformed detached worktree record.");
  }
  return {
    jobId: value.jobId,
    title: value.title.slice(0, 160),
    backend: value.backend,
    path: value.path,
    branch: value.branch,
    repoRoot: value.repoRoot,
    ...(typeof value.nativeWorktreeId === "string"
      ? { nativeWorktreeId: value.nativeWorktreeId }
      : {}),
    ...(typeof value.leadAgentId === "string"
      ? { leadAgentId: value.leadAgentId }
      : {}),
    detachedAt: value.detachedAt,
  };
}

export class DetachedWorktreeStore {
  readonly filePath: string;
  private readonly records = new Map<string, DetachedWorktreeRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "detached-worktrees.json");
  }

  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot read detached worktrees: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        "Detached worktrees are malformed JSON; refusing replay.",
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== VERSION ||
      !Array.isArray(parsed.records)
    ) {
      throw new Error("Detached worktrees have an unsupported schema.");
    }
    this.records.clear();
    for (const value of parsed.records) {
      const record = parse(value);
      if (this.records.has(record.jobId))
        throw new Error(`Duplicate detached worktree: ${record.jobId}`);
      this.records.set(record.jobId, record);
    }
  }

  list(): ReadonlyArray<DetachedWorktreeRecord> {
    return [...this.records.values()].sort(
      (a, b) => b.detachedAt - a.detachedAt || a.jobId.localeCompare(b.jobId),
    );
  }

  async add(record: DetachedWorktreeRecord): Promise<void> {
    this.records.set(record.jobId, { ...record });
    await this.save();
  }

  async remove(jobId: string): Promise<void> {
    if (!this.records.delete(jobId)) return;
    await this.save();
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
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
