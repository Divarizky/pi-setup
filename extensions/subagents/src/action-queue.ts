import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SubagentJobId } from "./domain.ts";
import { withDurableWrite } from "./durable-write.ts";

const MAX_TEXT = 2_000;

export const ACTION_EVENT_TYPES = [
  "job_settled",
  "job_failed",
  "status_unknown",
  "identity_mismatch",
  "session_dead",
  "recovery_required",
  "approval_required",
] as const;
export type ActionEventType = (typeof ACTION_EVENT_TYPES)[number];

export interface ActionEvent {
  readonly kind: "action-event";
  readonly actionId: string;
  readonly jobId: SubagentJobId;
  readonly type: ActionEventType;
  readonly at: number;
  readonly message: string;
  readonly evidence?: string;
}

export interface ActionReceipt {
  readonly kind: "action-receipt";
  readonly actionId: string;
  readonly at: number;
  readonly confirmedBy: "agent";
}

export interface ActionRecord {
  readonly event: ActionEvent;
  readonly receipt?: ActionReceipt;
  readonly status: "pending" | "confirmed";
}

export class ActionQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionQueueError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEvent(value: unknown): ActionEvent {
  if (!isRecord(value) || value.kind !== "action-event") {
    throw new ActionQueueError("Malformed action event.");
  }
  if (
    typeof value.actionId !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.type !== "string" ||
    !ACTION_EVENT_TYPES.includes(value.type as ActionEventType) ||
    typeof value.at !== "number" ||
    typeof value.message !== "string"
  ) {
    throw new ActionQueueError("Malformed action event fields.");
  }
  return {
    kind: "action-event",
    actionId: value.actionId,
    jobId: value.jobId,
    type: value.type as ActionEventType,
    at: value.at,
    message: value.message.slice(0, MAX_TEXT),
    ...(typeof value.evidence === "string"
      ? { evidence: value.evidence.slice(0, MAX_TEXT) }
      : {}),
  };
}

function parseReceipt(value: unknown): ActionReceipt {
  if (!isRecord(value) || value.kind !== "action-receipt") {
    throw new ActionQueueError("Malformed action receipt.");
  }
  if (
    typeof value.actionId !== "string" ||
    typeof value.at !== "number" ||
    value.confirmedBy !== "agent"
  ) {
    throw new ActionQueueError("Malformed action receipt fields.");
  }
  return {
    kind: "action-receipt",
    actionId: value.actionId,
    at: value.at,
    confirmedBy: "agent",
  };
}

export class ActionQueue {
  readonly filePath: string;
  private readonly records = new Map<string, ActionRecord>();
  private readonly deletedJobs = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "action-queue.jsonl");
  }

  async restore() {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ActionQueueError(`Cannot read action queue: ${String(error)}`);
    }
    for (const line of raw.split(/\r?\n/).filter((item) => item.trim())) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new ActionQueueError(
          "Action queue contains malformed JSON; refusing replay.",
        );
      }
      if (isRecord(value) && value.kind === "action-event") {
        const event = parseEvent(value);
        if (this.records.has(event.actionId)) continue;
        this.records.set(event.actionId, { event, status: "pending" });
      } else {
        const receipt = parseReceipt(value);
        const current = this.records.get(receipt.actionId);
        if (!current)
          throw new ActionQueueError(
            `Receipt has no matching action: ${receipt.actionId}`,
          );
        if (current.receipt) continue;
        this.records.set(receipt.actionId, {
          ...current,
          receipt,
          status: "confirmed",
        });
      }
    }
  }

  list(status?: ActionRecord["status"]) {
    return [...this.records.values()].filter(
      (record) => !status || record.status === status,
    );
  }

  get(actionId: string) {
    return this.records.get(actionId);
  }

  async enqueue(event: Omit<ActionEvent, "kind">) {
    if (this.deletedJobs.has(event.jobId))
      throw new ActionQueueError(`Job was deleted: ${event.jobId}`);
    const existing = this.records.get(event.actionId);
    if (existing) return existing;
    const actionEvent: ActionEvent = {
      kind: "action-event",
      ...event,
      message: event.message.slice(0, MAX_TEXT),
      ...(event.evidence === undefined
        ? {}
        : { evidence: event.evidence.slice(0, MAX_TEXT) }),
    };
    return this.enqueueWrite(async () => {
      if (this.deletedJobs.has(event.jobId))
        throw new ActionQueueError(`Job was deleted: ${event.jobId}`);
      const current = this.records.get(event.actionId);
      if (current) return current;
      await this.append(actionEvent);
      const record: ActionRecord = { event: actionEvent, status: "pending" };
      this.records.set(actionEvent.actionId, record);
      return record;
    });
  }

  async deleteJob(jobId: string): Promise<void> {
    this.deletedJobs.add(jobId);
    for (const key of [...this.records.keys()]) {
      if (this.records.get(key)?.event.jobId === jobId)
        this.records.delete(key);
    }
    return this.enqueueWrite(async () => {
      const remaining = this.list().filter(
        (record) => record.event.jobId !== jobId,
      );
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
      const lines = remaining.flatMap((record) => [
        JSON.stringify(record.event),
        ...(record.receipt ? [JSON.stringify(record.receipt)] : []),
      ]);
      await writeFile(
        temporaryPath,
        lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    });
  }

  async confirm(actionId: string): Promise<ActionRecord> {
    const current = this.records.get(actionId);
    if (!current) throw new ActionQueueError(`Unknown action: ${actionId}`);
    if (this.deletedJobs.has(current.event.jobId))
      throw new ActionQueueError(`Job was deleted: ${current.event.jobId}`);
    if (current.status === "confirmed") return current;
    return this.enqueueWrite(async () => {
      const latest = this.records.get(actionId);
      if (!latest) throw new ActionQueueError(`Unknown action: ${actionId}`);
      if (this.deletedJobs.has(latest.event.jobId))
        throw new ActionQueueError(`Job was deleted: ${latest.event.jobId}`);
      if (latest.status === "confirmed") return latest;
      const receipt: ActionReceipt = {
        kind: "action-receipt",
        actionId,
        at: Date.now(),
        confirmedBy: "agent",
      };
      await this.append(receipt);
      const confirmed = { ...latest, receipt, status: "confirmed" as const };
      this.records.set(actionId, confirmed);
      return confirmed;
    });
  }

  private async append(value: ActionEvent | ActionReceipt) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(value)}\n`);
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
