import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  LeadAgentId,
  LeadAgentProposalId,
  SubagentMode,
  WorkflowTaskId,
} from "../domain.ts";
import { withDurableWrite } from "../durable-write.ts";

const VERSION = 1;
const MAX_TEXT = 32_000;

export type LeadAgentProposalStatus =
  "proposed" | "approved" | "rejected" | "dispatched";

export interface LeadAgentProposal {
  /** Compatibility field name; this is the LeadAgentProposalId. */
  readonly id: LeadAgentProposalId;
  readonly leadAgentId: LeadAgentId;
  readonly title: string;
  readonly prompt: string;
  readonly mode: SubagentMode;
  readonly workingDir?: string;
  readonly dependsOn: ReadonlyArray<WorkflowTaskId>;
  readonly priority: number;
  readonly status: LeadAgentProposalStatus;
  readonly createdAt: number;
  readonly decidedAt?: number;
  readonly decisionReason?: string;
}

export interface LeadAgentProposalInput {
  readonly id: LeadAgentProposalId;
  readonly leadAgentId: LeadAgentId;
  readonly title: string;
  readonly prompt: string;
  readonly mode: SubagentMode;
  readonly workingDir?: string;
  readonly dependsOn: ReadonlyArray<WorkflowTaskId>;
  readonly priority: number;
}

export class LeadAgentProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadAgentProposalError";
  }
}

function bounded(value: string, max = MAX_TEXT) {
  return value.slice(0, max);
}

function sanitize(value: string) {
  return bounded(value)
    .replace(
      /(token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@");
}

function validId(value: string) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function parseProposal(value: unknown): LeadAgentProposal {
  if (!value || typeof value !== "object")
    throw new LeadAgentProposalError("Malformed lead agent proposal.");
  const item = value as Partial<LeadAgentProposal>;
  if (
    typeof item.id !== "string" ||
    !validId(item.id) ||
    typeof item.leadAgentId !== "string" ||
    !validId(item.leadAgentId) ||
    typeof item.title !== "string" ||
    typeof item.prompt !== "string" ||
    (item.mode !== "scout" && item.mode !== "build") ||
    !Array.isArray(item.dependsOn) ||
    !item.dependsOn.every((id) => typeof id === "string") ||
    typeof item.priority !== "number" ||
    !["proposed", "approved", "rejected", "dispatched"].includes(
      item.status as string,
    ) ||
    typeof item.createdAt !== "number"
  )
    throw new LeadAgentProposalError("Malformed lead agent proposal fields.");
  return {
    id: item.id,
    leadAgentId: item.leadAgentId,
    title: sanitize(item.title).slice(0, 160),
    prompt: sanitize(item.prompt),
    mode: item.mode,
    ...(typeof item.workingDir === "string"
      ? { workingDir: sanitize(item.workingDir).slice(0, 4_096) }
      : {}),
    dependsOn: [...new Set(item.dependsOn)],
    priority: Number.isFinite(item.priority) ? Math.trunc(item.priority) : 0,
    status: item.status as LeadAgentProposalStatus,
    createdAt: item.createdAt,
    ...(typeof item.decidedAt === "number"
      ? { decidedAt: item.decidedAt }
      : {}),
    ...(typeof item.decisionReason === "string"
      ? { decisionReason: sanitize(item.decisionReason).slice(0, 4_096) }
      : {}),
  };
}

export class LeadAgentProposalStore {
  readonly filePath: string;
  private readonly legacyFilePath: string;
  private readonly proposals = new Map<string, LeadAgentProposal>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "lead-agent-proposals.json");
    this.legacyFilePath = path.join(rootDir, "resident-proposals.json");
  }

  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LeadAgentProposalError(
          `Cannot read lead agent proposals: ${String(error)}`,
        );
      }
      try {
        raw = await readFile(this.legacyFilePath, "utf8");
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new LeadAgentProposalError(
          `Cannot read legacy lead agent proposals: ${String(legacyError)}`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LeadAgentProposalError(
        "Lead agent proposals are malformed JSON; refusing replay.",
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== VERSION ||
      !Array.isArray((parsed as { proposals?: unknown }).proposals)
    ) {
      throw new LeadAgentProposalError(
        "Lead agent proposals have an unsupported schema.",
      );
    }
    this.proposals.clear();
    for (const value of (parsed as { proposals: unknown[] }).proposals) {
      const proposal = parseProposal(
        value && typeof value === "object"
          ? {
              ...(value as Record<string, unknown>),
              leadAgentId:
                (value as Record<string, unknown>).leadAgentId ??
                (value as Record<string, unknown>).residentId,
            }
          : value,
      );
      if (this.proposals.has(proposal.id))
        throw new LeadAgentProposalError(
          `Duplicate lead agent proposal: ${proposal.id}`,
        );
      this.proposals.set(proposal.id, proposal);
    }
  }

  get(id: string) {
    return this.proposals.get(id);
  }

  list(leadAgentId?: string): ReadonlyArray<LeadAgentProposal> {
    return [...this.proposals.values()]
      .filter(
        (proposal) =>
          leadAgentId === undefined || proposal.leadAgentId === leadAgentId,
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )
      .map((proposal) => ({ ...proposal }));
  }

  pending(leadAgentId?: string) {
    return this.list(leadAgentId).filter(
      (proposal) => proposal.status === "proposed",
    );
  }

  async create(input: LeadAgentProposalInput): Promise<LeadAgentProposal> {
    if (!validId(input.id) || !validId(input.leadAgentId))
      throw new LeadAgentProposalError("Invalid lead agent proposal identity.");
    if (this.proposals.has(input.id))
      throw new LeadAgentProposalError(
        `Lead agent proposal already exists: ${input.id}`,
      );
    const now = Date.now();
    const proposal: LeadAgentProposal = {
      id: input.id,
      leadAgentId: input.leadAgentId,
      title: sanitize(input.title).slice(0, 160),
      prompt: sanitize(input.prompt),
      mode: input.mode,
      ...(input.workingDir === undefined
        ? {}
        : { workingDir: sanitize(input.workingDir).slice(0, 4_096) }),
      dependsOn: [...new Set(input.dependsOn)],
      priority: Number.isFinite(input.priority)
        ? Math.trunc(input.priority)
        : 0,
      status: "proposed",
      createdAt: now,
    };
    this.proposals.set(proposal.id, proposal);
    await this.save();
    return proposal;
  }

  async approve(id: string): Promise<LeadAgentProposal> {
    const proposal = this.require(id);
    if (proposal.status === "rejected" || proposal.status === "dispatched")
      throw new LeadAgentProposalError(
        `Lead agent proposal is already settled: ${id}`,
      );
    if (proposal.status === "approved") return proposal;
    const next = {
      ...proposal,
      status: "approved" as const,
      decidedAt: Date.now(),
    };
    this.proposals.set(id, next);
    await this.save();
    return next;
  }

  async dispatch(id: string): Promise<LeadAgentProposal> {
    const proposal = this.require(id);
    if (proposal.status === "rejected")
      throw new LeadAgentProposalError(
        `Lead agent proposal is rejected: ${id}`,
      );
    if (proposal.status === "proposed")
      throw new LeadAgentProposalError(
        `Lead agent proposal requires parent approval: ${id}`,
      );
    if (proposal.status === "dispatched") return proposal;
    const next = {
      ...proposal,
      status: "dispatched" as const,
      decidedAt: proposal.decidedAt ?? Date.now(),
    };
    this.proposals.set(id, next);
    await this.save();
    return next;
  }

  async reject(id: string, reason: string): Promise<LeadAgentProposal> {
    const proposal = this.require(id);
    if (proposal.status !== "proposed")
      throw new LeadAgentProposalError(
        `Lead agent proposal is already settled: ${id}`,
      );
    const next = {
      ...proposal,
      status: "rejected" as const,
      decidedAt: Date.now(),
      decisionReason: sanitize(reason).slice(0, 4_096),
    };
    this.proposals.set(id, next);
    await this.save();
    return next;
  }

  /** Remove proposals that were never dispatched by a deleted Lead Agent. */
  async removeUndispatchedByLeadAgentId(
    leadAgentId: LeadAgentId,
  ): Promise<ReadonlyArray<LeadAgentProposalId>> {
    const removed = [...this.proposals.values()]
      .filter(
        (proposal) =>
          proposal.leadAgentId === leadAgentId &&
          (proposal.status === "proposed" || proposal.status === "approved"),
      )
      .map((proposal) => proposal.id);
    if (removed.length === 0) return removed;
    for (const proposalId of removed) this.proposals.delete(proposalId);
    await this.save();
    return removed;
  }

  private require(id: string) {
    const proposal = this.proposals.get(id);
    if (!proposal)
      throw new LeadAgentProposalError(`Unknown lead agent proposal: ${id}`);
    return proposal;
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: VERSION, proposals: this.list() }, null, 2)}\n`,
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
