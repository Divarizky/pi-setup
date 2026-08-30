import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseLeadAgentEvent, type LeadAgentEvent } from "./orchestration.ts";
import { withDurableWrite } from "../durable-write.ts";

/**
 * Cross-runtime handoff for Lead Agent events.
 *
 * Child Pi runtimes cannot acquire the parent runtime's state lease, so they
 * append validated events here. The parent drains the inbox and processes the
 * events through its single-writer coordinator.
 */
const MAX_INBOX_BYTES = 4 * 1024 * 1024;
const MAX_INBOX_LINES = 4_096;
const MAX_EVENT_BYTES = 128 * 1024;

export class LeadAgentInbox {
  readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "lead-agent-inbox.jsonl");
  }

  async enqueue(event: LeadAgentEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_EVENT_BYTES)
      throw new Error("Lead Agent event exceeds the inbox event limit.");
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.withLock(async () => {
      await this.assertSafeInboxFile();
      let currentBytes = 0;
      let currentLines = 0;
      try {
        const raw = await readFile(this.filePath, "utf8");
        currentBytes = Buffer.byteLength(raw, "utf8");
        currentLines = raw
          .split(/\r?\n/)
          .filter((item) => item.trim().length > 0).length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (currentBytes + bytes > MAX_INBOX_BYTES)
        throw new Error(
          "Lead Agent inbox is full; drain or acknowledge pending events before retrying.",
        );
      if (currentLines >= MAX_INBOX_LINES)
        throw new Error(
          "Lead Agent inbox has reached its event count limit; drain pending events before retrying.",
        );
      await withDurableWrite(() => appendFile(this.filePath, line, "utf8"));
    });
  }

  async drain(
    handler: (event: LeadAgentEvent) => Promise<void>,
  ): Promise<number> {
    const processingPath = `${this.filePath}.processing-${process.pid}-${Date.now()}`;
    let renamed = false;
    await this.withLock(async () => {
      await this.assertSafeInboxFile();
      try {
        await rename(this.filePath, processingPath);
        renamed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
    if (!renamed) return 0;

    let raw = "";
    let lines: string[];
    try {
      raw = await readFile(processingPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_INBOX_BYTES)
        throw new Error("Lead Agent inbox exceeds the size limit.");
      lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (lines.length > MAX_INBOX_LINES)
        throw new Error("Lead Agent inbox exceeds the event count limit.");
    } catch (error) {
      await this.restoreProcessing(processingPath, raw);
      throw error;
    }

    let processed = 0;
    try {
      for (; processed < lines.length; processed++) {
        const parsed: unknown = JSON.parse(lines[processed]!);
        await handler(parseLeadAgentEvent(parsed));
      }
    } catch (error) {
      const remaining = lines.slice(processed).join("\n");
      await this.restoreProcessing(processingPath, remaining);
      throw error;
    }

    await rm(processingPath, { force: true });
    return processed;
  }

  private async restoreProcessing(
    processingPath: string,
    remaining: string,
  ): Promise<void> {
    await this.withLock(async () => {
      await this.assertSafeInboxFile();
      if (remaining.length > 0) {
        await appendFile(this.filePath, `${remaining}\n`, "utf8");
      }
      await rm(processingPath, { force: true });
    });
  }

  private async assertSafeInboxFile(): Promise<void> {
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile())
        throw new Error(
          "Lead Agent inbox must be a regular file; refusing symlink or special file.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async withLock<A>(operation: () => Promise<A>): Promise<A> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    for (;;) {
      try {
        await mkdir(lockPath);
        const token = randomUUID();
        await writeFile(path.join(lockPath, "owner"), token, "utf8");
        try {
          return await operation();
        } finally {
          try {
            if (
              (await readFile(path.join(lockPath, "owner"), "utf8")) === token
            )
              await rm(lockPath, { recursive: true, force: true });
          } catch {
            /* another process already reclaimed the stale lock */
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = await stat(lockPath);
          if (Date.now() - lock.mtimeMs > 10 * 60_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          /* lock disappeared; retry */
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}
