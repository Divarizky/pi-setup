import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STALE_AFTER_MS = 60_000;

interface CapacityRecord {
  readonly jobId: string;
  readonly parentId: string;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

export interface CapacityLease {
  readonly jobId: string;
  readonly parentId: string;
  readonly token: string;
  readonly slotPath: string;
  release(): Promise<void>;
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Crash-safe global concurrency pool shared by all parent Pi runtimes. */
export class GlobalCapacityPool {
  readonly rootDir: string;
  readonly maxSlots: number;
  private readonly localLeases = new Map<string, CapacityLease>();

  constructor(rootDir: string, maxSlots = 4) {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      throw new Error("Capacity pool requires at least one slot.");
    }
    this.rootDir = rootDir;
    this.maxSlots = maxSlots;
  }

  async tryAcquire(
    jobId: string,
    parentId: string,
  ): Promise<CapacityLease | undefined> {
    const local = this.localLeases.get(jobId);
    if (local) return local;
    await mkdir(this.rootDir, { recursive: true });

    for (let index = 0; index < this.maxSlots; index++) {
      const slotPath = path.join(this.rootDir, `slot-${index}.lock`);
      const token = randomUUID();
      const record: CapacityRecord = {
        jobId,
        parentId,
        pid: process.pid,
        token,
        createdAt: Date.now(),
      };
      try {
        const handle = await open(slotPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        let released = false;
        const pool = this;
        const lease: CapacityLease = {
          jobId,
          parentId,
          token,
          slotPath,
          async release() {
            if (released) return;
            released = true;
            await pool.release(jobId, token, slotPath);
          },
        };
        this.localLeases.set(jobId, lease);
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.reapIfStale(slotPath)) index--;
      }
    }
    return undefined;
  }

  async release(
    jobId: string,
    token: string,
    slotPath?: string,
  ): Promise<void> {
    const local = this.localLeases.get(jobId);
    if (local?.token === token) this.localLeases.delete(jobId);
    const candidates = slotPath
      ? [slotPath]
      : Array.from({ length: this.maxSlots }, (_, index) =>
          path.join(this.rootDir, `slot-${index}.lock`),
        );
    for (const candidate of candidates) {
      try {
        const record = JSON.parse(
          await readFile(candidate, "utf8"),
        ) as Partial<CapacityRecord>;
        if (record.jobId === jobId && record.token === token) {
          await rm(candidate, { force: true });
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    }
  }

  async list(): Promise<ReadonlyArray<CapacityRecord>> {
    await mkdir(this.rootDir, { recursive: true });
    const records: CapacityRecord[] = [];
    for (let index = 0; index < this.maxSlots; index++) {
      const slotPath = path.join(this.rootDir, `slot-${index}.lock`);
      try {
        const record = JSON.parse(
          await readFile(slotPath, "utf8"),
        ) as CapacityRecord;
        if (
          typeof record.jobId === "string" &&
          typeof record.parentId === "string" &&
          Number.isInteger(record.pid)
        ) {
          records.push(record);
        }
      } catch {
        // A partially-written or malformed slot is not counted until it is stale.
      }
    }
    return records;
  }

  private async reapIfStale(slotPath: string): Promise<boolean> {
    try {
      const raw = await readFile(slotPath, "utf8");
      const record = JSON.parse(raw) as Partial<CapacityRecord>;
      if (typeof record.pid === "number" && isProcessAlive(record.pid))
        return false;
      await rm(slotPath, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      try {
        const info = await stat(slotPath);
        if (Date.now() - info.mtimeMs > STALE_AFTER_MS) {
          await rm(slotPath, { force: true });
          return true;
        }
      } catch {
        // Never turn a transient read/stat race into an unsafe deletion.
      }
      return false;
    }
  }
}
