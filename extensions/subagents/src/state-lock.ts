import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_WAIT_MS = 2_000;
const RETRY_MS = 50;
const STALE_AFTER_MS = 60_000;

export class StateLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateLeaseError";
  }
}

export interface StateLease {
  readonly path: string;
  release(): Promise<void>;
}

interface LockRecord {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
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

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireStateLease(
  rootDir: string,
  options: { readonly waitMs?: number } = {},
): Promise<StateLease> {
  await mkdir(rootDir, { recursive: true });
  const lockPath = path.join(rootDir, ".subagents-state.lock");
  const deadline = Date.now() + Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
  const token = randomUUID();
  const record: LockRecord = { pid: process.pid, token, createdAt: Date.now() };

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(
              await readFile(lockPath, "utf8"),
            ) as Partial<LockRecord>;
            if (current.token === token) await rm(lockPath, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StateLeaseError(
          `Cannot acquire state lease: ${String(error)}`,
        );
      }

      let current: Partial<LockRecord> = {};
      let stale = false;
      try {
        current = JSON.parse(
          await readFile(lockPath, "utf8"),
        ) as Partial<LockRecord>;
        stale = !isProcessAlive(current.pid ?? 0);
      } catch {
        try {
          stale = Date.now() - (await stat(lockPath)).mtimeMs > STALE_AFTER_MS;
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
      }
      if (stale) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (current.pid) {
        throw new StateLeaseError(
          `State directory is already owned by a live runtime (pid ${current.pid}).`,
        );
      }
      if (Date.now() >= deadline) {
        throw new StateLeaseError(
          "Timed out waiting for the subagent state lease.",
        );
      }
      await delay(RETRY_MS);
    }
  }
}
