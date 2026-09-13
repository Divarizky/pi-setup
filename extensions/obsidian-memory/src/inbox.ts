import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryInboxPayload {
  readonly cwd: string;
  readonly sessionId: string;
  readonly runKey: string;
  readonly recap: string;
  readonly next: string;
  readonly projectSlug: string | null;
  readonly date: string;
}

function cleanText(value: string): string {
  return (
    value
      // Strip terminal control sequences before persisting model output.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(
        /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
        "$1 [REDACTED]",
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|npm_[A-Za-z0-9]{20,})\b/g,
        "[REDACTED TOKEN]",
      )
      .trim()
  );
}

function safePart(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-");
  return cleaned.slice(0, 48) || fallback;
}

function eventHash(payload: MemoryInboxPayload): string {
  return createHash("sha256")
    .update(`${payload.sessionId}:${payload.runKey}`)
    .digest("hex")
    .slice(0, 12);
}

export function buildInboxPath(
  payload: MemoryInboxPayload,
  vault: string,
): string {
  const session = safePart(payload.sessionId, "session");
  return join(
    vault,
    "inbox",
    payload.date,
    `${session}-${eventHash(payload)}.md`,
  );
}

export function buildInboxNote(payload: MemoryInboxPayload): string {
  const project = payload.projectSlug ?? "none";
  const projectLink = payload.projectSlug
    ? `\n- [[projects/${payload.projectSlug}/overview]]`
    : "";
  const recap = cleanText(payload.recap);
  const next = cleanText(payload.next);

  return `---
type: pi-memory-inbox
date: ${payload.date}
session: ${safePart(payload.sessionId, "session")}
project: ${project}
---

# Pi Run Recap — ${payload.date}

## TL;DR
${recap}

## Next Step
- ${next}

## See Also
- [[knowledge/vault-memory-system]]${projectLink}
`;
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 5;

function isStaleLock(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function waitForWriter(target: string, lock: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(target)) return false;
    if (!existsSync(lock)) return true;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  return false;
}

export async function writeInboxEntry(
  payload: MemoryInboxPayload,
  vault: string,
): Promise<{ path: string; created: boolean }> {
  if (!existsSync(vault) || !statSync(vault).isDirectory()) {
    throw new Error("Memory vault is unavailable");
  }
  const target = buildInboxPath(payload, vault);
  await mkdir(join(vault, "inbox", payload.date), { recursive: true });
  const lock = `${target}.lock`;

  while (true) {
    if (existsSync(target)) return { path: target, created: false };

    let ownsLock = false;
    try {
      // O_EXCL gives this process one writer for the stable target path.
      await writeFile(lock, `${process.pid}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      ownsLock = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (isStaleLock(lock)) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      // Another delivery is completing the same target. Wait for either the
      // atomic rename or lock release, then retry if the writer failed.
      if (await waitForWriter(target, lock)) continue;
      return { path: target, created: false };
    }

    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      if (existsSync(target)) return { path: target, created: false };
      await writeFile(temporary, buildInboxNote(payload), "utf8");
      // Same-directory rename is atomic, so readers never see a partial note.
      await rename(temporary, target);
      return { path: target, created: true };
    } finally {
      await unlink(temporary).catch(() => undefined);
      if (ownsLock) await unlink(lock).catch(() => undefined);
    }
  }
}
