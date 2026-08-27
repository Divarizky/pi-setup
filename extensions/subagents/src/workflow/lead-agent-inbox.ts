import { appendFile, mkdir, readFile, rename, rm } from "node:fs/promises";
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
export class LeadAgentInbox {
  readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "lead-agent-inbox.jsonl");
  }

  async enqueue(event: LeadAgentEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await withDurableWrite(() =>
      appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8"),
    );
  }

  async drain(
    handler: (event: LeadAgentEvent) => Promise<void>,
  ): Promise<number> {
    const processingPath = `${this.filePath}.processing-${process.pid}-${Date.now()}`;
    try {
      await rename(this.filePath, processingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    let lines: string[];
    try {
      lines = (await readFile(processingPath, "utf8"))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
    } catch (error) {
      await this.restoreProcessing(processingPath, "");
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
    if (remaining.length > 0) {
      await appendFile(this.filePath, `${remaining}\n`, "utf8");
    }
    await rm(processingPath, { force: true });
  }
}
