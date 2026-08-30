import type {
  LeadAgentId,
  LeadAgentProposalId,
  SubagentMode,
  WorkflowTaskId,
} from "../domain.ts";

export const LEAD_AGENT_EVENT_TYPES = [
  "proposal",
  "worker_done",
  "escalation",
  "ask",
  "reply",
] as const;

export type LeadAgentEventType = (typeof LEAD_AGENT_EVENT_TYPES)[number];

export interface LeadAgentEventBase {
  readonly eventId: string;
  readonly type: LeadAgentEventType;
  readonly actorId: string;
  readonly leadAgentId: LeadAgentId;
  readonly taskId?: WorkflowTaskId;
  readonly correlationId?: string;
  readonly at: number;
}

export type LeadAgentEvent =
  | (LeadAgentEventBase & {
      readonly type: "proposal";
      readonly proposalId: LeadAgentProposalId;
      readonly title: string;
      readonly prompt: string;
      readonly mode: SubagentMode;
      readonly workingDir?: string;
      readonly dependsOn: ReadonlyArray<string>;
      readonly priority: number;
    })
  | (LeadAgentEventBase & {
      readonly type: "worker_done";
      readonly summary: string;
    })
  | (LeadAgentEventBase & {
      readonly type: "escalation";
      readonly reason: string;
      readonly question?: string;
    })
  | (LeadAgentEventBase & {
      readonly type: "ask";
      readonly question: string;
    })
  | (LeadAgentEventBase & {
      readonly type: "reply";
      readonly answer: string;
      readonly replyTo: string;
    });

const MAX_TEXT = 32_000;
const ID = /^[A-Za-z0-9._-]{1,128}$/;

function text(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Lead Agent event requires ${name}.`);
  return value.trim().slice(0, max);
}

function id(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!ID.test(result)) throw new Error(`Invalid Lead Agent event ${name}.`);
  return result;
}

function base(value: Record<string, unknown>): LeadAgentEventBase {
  if (typeof value.at !== "number" || !Number.isFinite(value.at))
    throw new Error("Lead Agent event requires a valid timestamp.");
  const type = value.type;
  if (!LEAD_AGENT_EVENT_TYPES.includes(type as LeadAgentEventType))
    throw new Error("Unsupported Lead Agent event type.");
  return {
    eventId: id(value.eventId, "event id"),
    type: type as LeadAgentEventType,
    actorId: id(value.actorId, "actor id"),
    leadAgentId: id(value.leadAgentId, "lead agent id"),
    ...(value.taskId === undefined
      ? {}
      : { taskId: id(value.taskId, "task id") }),
    ...(value.correlationId === undefined
      ? {}
      : { correlationId: id(value.correlationId, "correlation id") }),
    at: value.at,
  };
}

export function parseLeadAgentEvent(value: unknown): LeadAgentEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Lead Agent event.");
  const record = value as Record<string, unknown>;
  const common = base(record);
  switch (common.type) {
    case "proposal": {
      const mode = record.mode;
      if (mode !== "scout" && mode !== "build")
        throw new Error("Lead Agent proposal requires scout or build mode.");
      if (
        !Array.isArray(record.dependsOn) ||
        !record.dependsOn.every(
          (item) => typeof item === "string" && ID.test(item),
        )
      ) {
        throw new Error("Lead Agent proposal dependencies are malformed.");
      }
      return {
        ...common,
        type: "proposal",
        proposalId: id(record.proposalId, "proposal id"),
        title: text(record.title, "proposal title", 160),
        prompt: text(record.prompt, "proposal prompt"),
        mode,
        ...(record.workingDir === undefined
          ? {}
          : {
              workingDir: text(record.workingDir, "working directory", 4_096),
            }),
        dependsOn: [...new Set(record.dependsOn)],
        priority:
          typeof record.priority === "number" &&
          Number.isFinite(record.priority)
            ? Math.trunc(record.priority)
            : 0,
      };
    }
    case "worker_done":
      return {
        ...common,
        type: "worker_done",
        summary: text(record.summary, "worker summary", 4_096),
      };
    case "escalation":
      return {
        ...common,
        type: "escalation",
        reason: text(record.reason, "escalation reason", 4_096),
        ...(record.question === undefined
          ? {}
          : { question: text(record.question, "escalation question", 4_096) }),
      };
    case "ask":
      return {
        ...common,
        type: "ask",
        question: text(record.question, "question", 4_096),
      };
    case "reply":
      return {
        ...common,
        type: "reply",
        answer: text(record.answer, "reply answer", 4_096),
        replyTo: id(record.replyTo, "reply target"),
      };
  }
}
