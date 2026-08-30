import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { withDurableWrite } from "./durable-write.ts";
import type { LeadAgentId } from "./domain.ts";

export const LEAD_HOME_STATUSES = [
  "provisioning",
  "active",
  "paused",
  "recovery-required",
  "stopping",
  "retired",
  "failed",
] as const;
export type LeadHomeStatus = (typeof LEAD_HOME_STATUSES)[number];

export interface LeadProject {
  readonly projectId: string;
  readonly source: string;
  readonly clonePath: string;
  readonly createdAt: number;
}

export interface LeadProjectInput {
  readonly projectId: string;
  readonly source: string;
}

export interface AgentLeadHome {
  readonly leadAgentId: LeadAgentId;
  readonly homePath: string;
  readonly stateRoot: string;
  readonly parentStateRoot: string;
  readonly projects: ReadonlyArray<LeadProject>;
  readonly status: LeadHomeStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly failureReason?: string;
}

const VERSION = 1;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const execFile = promisify(execFileCallback);

export function isLeadHomeId(value: string): boolean {
  return ID.test(value);
}

function assertHomeLayout(home: AgentLeadHome, expectedHomePath: string): void {
  if (path.resolve(home.homePath) !== path.resolve(expectedHomePath))
    throw new Error(
      "Agent Lead home manifest path does not match its managed directory.",
    );
  if (
    path.resolve(home.stateRoot) !==
    path.join(path.resolve(expectedHomePath), "state")
  )
    throw new Error(
      "Agent Lead home state root escaped its managed directory.",
    );
  const projectsRoot = path.join(path.resolve(expectedHomePath), "projects");
  for (const project of home.projects) {
    const clonePath = path.resolve(project.clonePath);
    const relative = path.relative(projectsRoot, clonePath);
    if (
      relative !== project.projectId ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "Agent Lead project clone escaped its managed directory.",
      );
    }
  }
}

function parseHome(value: unknown): AgentLeadHome {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Agent Lead home manifest.");
  const item = value as Partial<AgentLeadHome>;
  if (
    typeof item.leadAgentId !== "string" ||
    !isLeadHomeId(item.leadAgentId) ||
    typeof item.homePath !== "string" ||
    typeof item.stateRoot !== "string" ||
    typeof item.parentStateRoot !== "string" ||
    !Array.isArray(item.projects) ||
    !LEAD_HOME_STATUSES.includes(item.status as LeadHomeStatus) ||
    typeof item.createdAt !== "number" ||
    typeof item.updatedAt !== "number"
  )
    throw new Error("Malformed Agent Lead home manifest fields.");
  const status = item.status as LeadHomeStatus;
  const projects = item.projects.map((project) => {
    if (!project || typeof project !== "object")
      throw new Error("Malformed Agent Lead project manifest.");
    const value = project as Partial<LeadProject>;
    if (
      typeof value.projectId !== "string" ||
      !ID.test(value.projectId) ||
      typeof value.source !== "string" ||
      typeof value.clonePath !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      throw new Error("Malformed Agent Lead project manifest fields.");
    }
    return {
      projectId: value.projectId,
      source: value.source,
      clonePath: value.clonePath,
      createdAt: value.createdAt,
    };
  });
  return {
    leadAgentId: item.leadAgentId,
    homePath: item.homePath,
    stateRoot: item.stateRoot,
    parentStateRoot: item.parentStateRoot,
    projects,
    status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(typeof item.failureReason === "string"
      ? { failureReason: item.failureReason.slice(0, 4096) }
      : {}),
  };
}

export function leadHomeTransitions(
  status: LeadHomeStatus,
  target: LeadHomeStatus,
): boolean {
  if (status === target) return true;
  if (status === "provisioning")
    return target === "active" || target === "failed";
  if (status === "active")
    return (
      target === "paused" ||
      target === "recovery-required" ||
      target === "stopping" ||
      target === "failed"
    );
  if (status === "paused")
    return (
      target === "active" ||
      target === "stopping" ||
      target === "recovery-required"
    );
  if (status === "recovery-required")
    return target === "active" || target === "stopping" || target === "failed";
  if (status === "stopping")
    return target === "retired" || target === "recovery-required";
  return false;
}

export class LeadHomeStore {
  readonly manifestPath: string;
  private home?: AgentLeadHome;
  private writeChain: Promise<void> = Promise.resolve();

  readonly homePath: string;

  constructor(homePath: string) {
    this.homePath = homePath;
    this.manifestPath = path.join(homePath, "manifest.json");
  }

  get(): AgentLeadHome | undefined {
    return this.home;
  }

  async restore(): Promise<AgentLeadHome | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot read Agent Lead home manifest: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Agent Lead home manifest is malformed JSON.");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== VERSION
    )
      throw new Error("Agent Lead home manifest has an unsupported schema.");
    this.home = parseHome((parsed as { home?: unknown }).home);
    assertHomeLayout(this.home, this.homePath);
    return this.home;
  }

  async create(
    input: Omit<AgentLeadHome, "createdAt" | "updatedAt">,
  ): Promise<AgentLeadHome> {
    if (!isLeadHomeId(input.leadAgentId))
      throw new Error("Invalid Agent Lead home id.");
    if (this.home)
      throw new Error(`Agent Lead home already exists: ${input.leadAgentId}`);
    const now = Date.now();
    const home = { ...input, createdAt: now, updatedAt: now };
    assertHomeLayout(home, this.homePath);
    this.home = home;
    await this.save();
    return home;
  }

  async setProjects(
    projects: ReadonlyArray<LeadProject>,
  ): Promise<AgentLeadHome> {
    if (!this.home) throw new Error("Agent Lead home is not initialized.");
    const next = {
      ...this.home,
      projects: [...projects],
      updatedAt: Date.now(),
    };
    assertHomeLayout(next, this.homePath);
    this.home = next;
    await this.save();
    return this.home;
  }

  async transition(
    status: LeadHomeStatus,
    failureReason?: string,
  ): Promise<AgentLeadHome> {
    if (!this.home) throw new Error("Agent Lead home is not initialized.");
    if (!leadHomeTransitions(this.home.status, status))
      throw new Error(
        `Invalid Agent Lead home transition: ${this.home.status} -> ${status}.`,
      );
    this.home = {
      ...this.home,
      status,
      updatedAt: Date.now(),
      ...(failureReason === undefined
        ? {}
        : { failureReason: failureReason.slice(0, 4096) }),
    };
    await this.save();
    return this.home;
  }

  async remove(): Promise<void> {
    await rm(this.homePath, { recursive: true, force: true });
    this.home = undefined;
  }

  private save(): Promise<void> {
    const operation = async () => {
      await mkdir(this.homePath, { recursive: true });
      const temporary = `${this.manifestPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: VERSION, home: this.home }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, this.manifestPath);
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

export function validateLeadProjectSource(source: string): "local" | "remote" {
  const value = source.trim();
  if (!value) throw new Error("Agent Lead project source cannot be empty.");
  // Windows drive paths must remain local paths, not URL schemes.
  if (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith(".") ||
    value.startsWith("/")
  )
    return "local";
  if (/^git@[^:\\s/]+:[^\\s]+$/.test(value)) return "remote";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "local";
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:")
    throw new Error("Remote project source must use HTTPS or SSH Git URLs.");
  if (
    !url.hostname ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "https:" && url.username)
  )
    throw new Error("Remote project source has unsafe URL components.");
  return "remote";
}

/** Clone the explicitly approved project set into a new Lead home. */
export async function provisionLeadProjects(
  homePath: string,
  inputs: ReadonlyArray<LeadProjectInput>,
): Promise<ReadonlyArray<LeadProject>> {
  const projectsRoot = path.join(homePath, "projects");
  await mkdir(projectsRoot, { recursive: true });
  const created: string[] = [];
  try {
    const projects: LeadProject[] = [];
    for (const input of inputs) {
      if (!isLeadHomeId(input.projectId))
        throw new Error(`Invalid Agent Lead project id: ${input.projectId}`);
      const source = input.source.trim();
      const sourceKind = validateLeadProjectSource(source);
      const clonePath = path.join(projectsRoot, input.projectId);
      const relative = path.relative(projectsRoot, clonePath);
      if (
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative)
      )
        throw new Error("Agent Lead project clone escaped its home.");
      try {
        await stat(clonePath);
        throw new Error(
          `Agent Lead project clone already exists: ${input.projectId}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const isLocal = sourceKind === "local";
      created.push(clonePath);
      if (isLocal) {
        const sourcePath = path.resolve(source);
        const sourceInfo = await stat(sourcePath);
        if (!sourceInfo.isDirectory())
          throw new Error(
            `Agent Lead project source is not a directory: ${source}`,
          );
        await execFile("git", ["clone", "--no-local", sourcePath, clonePath], {
          maxBuffer: 64 * 1024,
        });
      } else {
        await execFile("git", ["clone", "--", source, clonePath], {
          maxBuffer: 64 * 1024,
        });
      }
      projects.push({
        projectId: input.projectId,
        source,
        clonePath: await realpath(clonePath),
        createdAt: Date.now(),
      });
    }
    return projects;
  } catch (error) {
    await Promise.all(
      created.map((clonePath) =>
        rm(clonePath, { recursive: true, force: true }).catch(() => {}),
      ),
    );
    throw error;
  }
}
