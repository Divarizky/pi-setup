import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { SessionSemanticStatus } from "../backend.ts";
import { boundedError } from "../security.ts";
import { buildSubagentExecutionPrompt } from "../prompt.ts";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface OrcaCliResult<T> {
  readonly ok: boolean;
  readonly result?: T;
}

export interface OrcaCreatedTerminal {
  readonly handle: string;
  readonly worktreeId?: string;
  readonly tabId?: string;
  readonly paneKey?: string;
  readonly sessionId?: string;
  readonly launchToken?: string;
}

export interface OrcaCreatedPiWorktree {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly repoId: string;
  readonly terminalHandle: string;
  readonly terminal: OrcaCreatedTerminal;
}

export interface OrcaTerminal {
  readonly handle: string;
  readonly worktreeId: string;
  readonly worktreePath?: string;
  readonly tabId?: string;
  readonly paneKey?: string;
  readonly sessionId?: string;
  readonly launchToken?: string;
  readonly title?: string;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly orphaned: boolean;
  readonly lastOutputAt?: number;
}

export interface OrcaRuntimeStatus {
  readonly reachable: boolean;
  readonly state: string;
}

function defaultCommand() {
  const configured = process.env.ORCA_CLI_COMMAND?.trim();
  if (configured) {
    // execFile deliberately accepts an executable path only; command strings
    // with arguments would require a shell and are rejected fail-closed.
    if (/\s/.test(configured))
      throw new Error("ORCA_CLI_COMMAND must be one executable path.");
    return configured;
  }
  return process.platform === "linux" ? "orca-ide" : "orca";
}

export function samePath(left: string | undefined, right: string) {
  if (!left) return false;
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function parseEnvelope<T>(raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Orca CLI returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new Error("Orca CLI returned an unsupported response.");
  }
  const envelope = parsed as OrcaCliResult<T>;
  if (envelope.ok !== true || envelope.result === undefined) {
    throw new Error("Orca CLI did not complete the operation.");
  }
  return envelope.result;
}

function asTerminal(value: unknown): OrcaTerminal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.handle !== "string" ||
    typeof record.worktreeId !== "string" ||
    typeof record.connected !== "boolean" ||
    typeof record.writable !== "boolean" ||
    typeof record.orphaned !== "boolean"
  )
    return undefined;
  return {
    handle: record.handle,
    worktreeId: record.worktreeId,
    connected: record.connected,
    writable: record.writable,
    orphaned: record.orphaned,
    ...(typeof record.worktreePath === "string"
      ? { worktreePath: record.worktreePath }
      : {}),
    ...(typeof record.tabId === "string" ? { tabId: record.tabId } : {}),
    ...(typeof record.paneKey === "string" ? { paneKey: record.paneKey } : {}),
    ...(typeof record.sessionId === "string"
      ? { sessionId: record.sessionId }
      : {}),
    ...(typeof record.launchToken === "string"
      ? { launchToken: record.launchToken }
      : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.lastOutputAt === "number"
      ? { lastOutputAt: record.lastOutputAt }
      : {}),
  };
}

export class OrcaCli {
  readonly command: string;

  constructor(command = defaultCommand()) {
    this.command = command;
  }

  async run(command: string, args: ReadonlyArray<string>) {
    try {
      const { stdout } = await execFile(command, [...args], {
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      return stdout;
    } catch (error) {
      throw new Error(`Orca CLI failed: ${boundedError(error, 2_000)}`);
    }
  }

  async createPiTerminal(options: {
    readonly worktreePath: string;
  }): Promise<OrcaCreatedTerminal> {
    const result = parseEnvelope<Record<string, unknown>>(
      await this.run(this.command, [
        "terminal",
        "create",
        "--worktree",
        `path:${options.worktreePath}`,
        "--command",
        "pi",
        "--json",
      ]),
    );
    const terminal = result.terminal as Record<string, unknown> | undefined;
    const handle =
      typeof result.handle === "string"
        ? result.handle
        : typeof terminal?.handle === "string"
          ? terminal.handle
          : undefined;
    if (!handle) throw new Error("Orca CLI did not return a terminal handle.");
    const worktreeId =
      typeof result.worktreeId === "string"
        ? result.worktreeId
        : typeof terminal?.worktreeId === "string"
          ? terminal.worktreeId
          : undefined;
    const tabId =
      typeof result.tabId === "string"
        ? result.tabId
        : typeof terminal?.tabId === "string"
          ? terminal.tabId
          : undefined;
    const paneKey =
      typeof result.paneKey === "string"
        ? result.paneKey
        : typeof terminal?.paneKey === "string"
          ? terminal.paneKey
          : undefined;
    const sessionId =
      typeof result.sessionId === "string"
        ? result.sessionId
        : typeof result.nativeSessionId === "string"
          ? result.nativeSessionId
          : typeof terminal?.sessionId === "string"
            ? terminal.sessionId
            : undefined;
    const launchToken =
      typeof result.launchToken === "string"
        ? result.launchToken
        : typeof terminal?.launchToken === "string"
          ? terminal.launchToken
          : undefined;
    return {
      handle,
      ...(worktreeId === undefined ? {} : { worktreeId }),
      ...(tabId === undefined ? {} : { tabId }),
      ...(paneKey === undefined ? {} : { paneKey }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(launchToken === undefined ? {} : { launchToken }),
    };
  }

  async createPiWorktree(options: {
    readonly repoPath: string;
    readonly name: string;
    readonly title?: string;
    readonly prompt: string;
  }): Promise<OrcaCreatedPiWorktree> {
    const prompt = buildSubagentExecutionPrompt({
      mode: "build",
      title: options.title ?? options.name,
      prompt: options.prompt,
    });
    const result = parseEnvelope<Record<string, unknown>>(
      await this.run(this.command, [
        "worktree",
        "create",
        "--repo",
        `path:${options.repoPath}`,
        "--name",
        options.name,
        "--agent",
        "pi",
        "--prompt",
        prompt,
        "--setup",
        "inherit",
        "--json",
      ]),
    );
    const worktree = result.worktree as Record<string, unknown> | undefined;
    const startupTerminal = result.startupTerminal as
      Record<string, unknown> | undefined;
    const terminalHandle =
      typeof result.agentTerminalHandle === "string"
        ? result.agentTerminalHandle
        : startupTerminal?.handle;
    if (
      !worktree ||
      typeof worktree.id !== "string" ||
      typeof worktree.path !== "string" ||
      typeof worktree.branch !== "string" ||
      typeof worktree.repoId !== "string" ||
      typeof terminalHandle !== "string"
    ) {
      throw new Error(
        "Orca CLI did not return a Pi worktree and terminal handle.",
      );
    }
    const terminal: OrcaCreatedTerminal = {
      handle: terminalHandle,
      worktreeId: worktree.id,
      ...(typeof result.tabId === "string"
        ? { tabId: result.tabId }
        : typeof startupTerminal?.tabId === "string"
          ? { tabId: startupTerminal.tabId }
          : {}),
      ...(typeof result.paneKey === "string"
        ? { paneKey: result.paneKey }
        : typeof startupTerminal?.paneKey === "string"
          ? { paneKey: startupTerminal.paneKey }
          : {}),
      ...(typeof result.sessionId === "string"
        ? { sessionId: result.sessionId }
        : typeof startupTerminal?.sessionId === "string"
          ? { sessionId: startupTerminal.sessionId }
          : {}),
      ...(typeof result.launchToken === "string"
        ? { launchToken: result.launchToken }
        : typeof startupTerminal?.launchToken === "string"
          ? { launchToken: startupTerminal.launchToken }
          : {}),
    };
    return {
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      repoId: worktree.repoId,
      terminalHandle,
      terminal,
    };
  }

  async showWorktree(
    worktreeId: string,
  ): Promise<{ readonly id: string; readonly path?: string }> {
    const result = parseEnvelope<Record<string, unknown>>(
      await this.run(this.command, [
        "worktree",
        "show",
        "--worktree",
        `id:${worktreeId}`,
        "--json",
      ]),
    );
    const worktree =
      result.worktree && typeof result.worktree === "object"
        ? (result.worktree as Record<string, unknown>)
        : result;
    const id = typeof worktree.id === "string" ? worktree.id : worktreeId;
    const worktreePath =
      typeof worktree.path === "string" ? worktree.path : undefined;
    return {
      id,
      ...(worktreePath === undefined ? {} : { path: worktreePath }),
    };
  }

  async removeWorktree(
    worktreeId: string,
    options: { readonly force?: boolean } = {},
  ) {
    const args = ["worktree", "rm", "--worktree", `id:${worktreeId}`];
    if (options.force) args.push("--force");
    args.push("--json");
    await this.run(this.command, args);
  }

  async listTerminals(
    worktreeId?: string,
  ): Promise<ReadonlyArray<OrcaTerminal>> {
    const args = ["terminal", "list"];
    if (worktreeId) args.push("--worktree", `id:${worktreeId}`);
    args.push("--json");
    const result = parseEnvelope<{ terminals?: unknown }>(
      await this.run(this.command, args),
    );
    if (!Array.isArray(result.terminals))
      throw new Error("Orca CLI returned no terminal list.");
    return result.terminals
      .map(asTerminal)
      .filter((item): item is OrcaTerminal => !!item);
  }

  async read(
    terminalHandle: string,
    options: { cursor?: number; limit?: number } = {},
  ) {
    const args = ["terminal", "read", "--terminal", terminalHandle];
    if (options.cursor !== undefined)
      args.push("--cursor", String(options.cursor));
    if (options.limit !== undefined)
      args.push("--limit", String(options.limit));
    args.push("--json");
    const result = parseEnvelope<unknown>(await this.run(this.command, args));
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Orca CLI returned an unsupported terminal read.");
    }
    // Terminal text is untrusted and may contain secrets; callers must not log
    // it or use it as lifecycle evidence without an explicit parser.
    return result as Readonly<Record<string, unknown>>;
  }

  async send(terminalHandle: string, text: string) {
    await this.run(this.command, [
      "terminal",
      "send",
      "--terminal",
      terminalHandle,
      "--text",
      text,
      "--enter",
      "--json",
    ]);
  }

  async waitForIdle(terminalHandle: string, timeoutMs: number) {
    await this.run(this.command, [
      "terminal",
      "wait",
      "--terminal",
      terminalHandle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      String(timeoutMs),
      "--json",
    ]);
  }

  async close(terminalHandle: string) {
    await this.run(this.command, [
      "terminal",
      "close",
      "--terminal",
      terminalHandle,
      "--json",
    ]);
  }

  async stop(worktreeId: string) {
    await this.run(this.command, [
      "terminal",
      "stop",
      "--worktree",
      `id:${worktreeId}`,
      "--json",
    ]);
  }

  /** Runtime readiness: spawn paths must fail closed before mutating anything. */
  async status(): Promise<OrcaRuntimeStatus> {
    const result = parseEnvelope<Record<string, unknown>>(
      await this.run(this.command, ["status", "--json"]),
    );
    const runtime = (result.runtime ?? {}) as Record<string, unknown>;
    return {
      reachable: runtime.reachable === true,
      state: typeof runtime.state === "string" ? runtime.state : "",
    };
  }

  async assertReady(): Promise<void> {
    const status = await this.status();
    if (!status.reachable || status.state !== "ready") {
      throw new Error(
        `Orca runtime is not ready (reachable=${status.reachable}, state=${status.state || "unknown"}). Start Orca and wait for the runtime to be ready.`,
      );
    }
  }

  /** Type text literally without submitting (no Enter). */
  async type(terminalHandle: string, text: string) {
    await this.run(this.command, [
      "terminal",
      "send",
      "--terminal",
      terminalHandle,
      "--text",
      text,
      "--json",
    ]);
  }

  /** Submit whatever is currently composed (Enter on empty text). */
  async submit(terminalHandle: string) {
    await this.run(this.command, [
      "terminal",
      "send",
      "--terminal",
      terminalHandle,
      "--text",
      "",
      "--enter",
      "--json",
    ]);
  }

  /** Send Ctrl-C to the terminal. */
  async interruptKey(terminalHandle: string) {
    await this.run(this.command, [
      "terminal",
      "send",
      "--terminal",
      terminalHandle,
      "--interrupt",
      "--json",
    ]);
  }
}

export interface OrcaTerminalBinding {
  readonly jobId: string;
  readonly terminalHandle: string;
  readonly worktreeId: string;
  readonly worktreePath?: string;
}

export interface OrcaTerminalEvidence {
  readonly jobId: string;
  readonly status: SessionSemanticStatus;
  readonly source: "orca-cli";
  readonly at: number;
  readonly eventName: string;
  readonly evidence?: string;
  readonly identityVerified: boolean;
}

/**
 * Typed Orca CLI adapter. It cannot infer AI idleness from terminal text, so a
 * connected terminal is `unknown`; only a disconnected/orphaned terminal is
 * classified as `dead`. All control is scoped to an explicit job binding.
 */
type LiteralCapableCli = Pick<
  OrcaCli,
  "listTerminals" | "read" | "send" | "waitForIdle" | "stop"
> & {
  readonly close?: (terminalHandle: string) => Promise<void>;
  readonly type?: (terminalHandle: string, text: string) => Promise<void>;
  readonly submit?: (terminalHandle: string) => Promise<void>;
  readonly interruptKey?: (terminalHandle: string) => Promise<void>;
};

export class OrcaTerminalAdapter {
  private readonly bindings = new Map<string, OrcaTerminalBinding>();
  private readonly cli: LiteralCapableCli;

  constructor(cli: LiteralCapableCli) {
    this.cli = cli;
  }

  /** True when the CLI can type text without submitting it. */
  get supportsLiteralTyping() {
    return typeof this.cli.type === "function";
  }

  /** True when the CLI can interrupt without destroying the terminal. */
  get supportsInterruptKey() {
    return typeof this.cli.interruptKey === "function";
  }

  attach(binding: OrcaTerminalBinding) {
    if (!binding.jobId || !binding.terminalHandle || !binding.worktreeId) {
      throw new Error(
        "Orca terminal binding requires jobId, terminalHandle, and worktreeId.",
      );
    }
    this.bindings.set(binding.jobId, binding);
  }

  detach(jobId: string) {
    this.bindings.delete(jobId);
  }

  async probe(
    jobId: string,
    at = Date.now(),
  ): Promise<OrcaTerminalEvidence | undefined> {
    const binding = this.bindings.get(jobId);
    if (!binding) return undefined;
    const terminals = await this.cli.listTerminals(binding.worktreeId);
    const terminal = terminals.find(
      (candidate) => candidate.handle === binding.terminalHandle,
    );
    if (
      !terminal ||
      terminal.worktreeId !== binding.worktreeId ||
      (binding.worktreePath !== undefined &&
        !samePath(terminal.worktreePath, binding.worktreePath)) ||
      terminal.orphaned ||
      !terminal.connected
    ) {
      return {
        jobId,
        status: "dead",
        source: "orca-cli",
        at,
        eventName: "terminal_disconnected",
        identityVerified: true,
      };
    }
    return {
      jobId,
      status: "unknown",
      source: "orca-cli",
      at,
      eventName: "terminal_connected_unverified",
      evidence:
        "Terminal is connected, but CLI status cannot prove AI idleness.",
      identityVerified: true,
    };
  }

  async send(jobId: string, text: string) {
    const binding = await this.requireVerifiedBinding(jobId);
    await this.cli.send(binding.terminalHandle, text);
  }

  async waitForIdle(jobId: string, timeoutMs: number) {
    const binding = await this.requireVerifiedBinding(jobId);
    await this.cli.waitForIdle(binding.terminalHandle, timeoutMs);
  }

  /** Type text without submitting; falls back to a plain send (with Enter) when unsupported. */
  async type(jobId: string, text: string) {
    const binding = await this.requireVerifiedBinding(jobId);
    if (this.cli.type) return this.cli.type(binding.terminalHandle, text);
    return this.cli.send(binding.terminalHandle, text);
  }

  /** Submit the composed input with Enter. */
  async submit(jobId: string) {
    const binding = await this.requireVerifiedBinding(jobId);
    if (this.cli.submit) return this.cli.submit(binding.terminalHandle);
    return this.cli.send(binding.terminalHandle, "");
  }

  /** Send Ctrl-C through the verified binding. */
  async interruptKey(jobId: string) {
    const binding = await this.requireVerifiedBinding(jobId);
    if (!this.cli.interruptKey)
      throw new Error("Orca CLI does not expose an interrupt key primitive.");
    return this.cli.interruptKey(binding.terminalHandle);
  }

  async read(jobId: string, options: { cursor?: number; limit?: number } = {}) {
    const binding = await this.requireVerifiedBinding(jobId);
    return this.cli.read(binding.terminalHandle, options);
  }

  async stop(jobId: string) {
    const binding = await this.requireVerifiedBinding(jobId);
    if (this.cli.close) {
      await this.cli.close(binding.terminalHandle);
      return;
    }
    const terminals = await this.cli.listTerminals(binding.worktreeId);
    if (
      terminals.filter((terminal) => terminal.worktreeId === binding.worktreeId)
        .length !== 1
    ) {
      throw new Error(
        "Refusing broad Orca worktree stop while terminal ownership is ambiguous.",
      );
    }
    await this.cli.stop(binding.worktreeId);
  }

  private async requireVerifiedBinding(jobId: string) {
    const binding = this.bindings.get(jobId);
    if (!binding)
      throw new Error(`No Orca terminal is attached to job ${jobId}.`);
    const terminals = await this.cli.listTerminals(binding.worktreeId);
    const terminal = terminals.find(
      (candidate) => candidate.handle === binding.terminalHandle,
    );
    if (
      !terminal ||
      terminal.worktreeId !== binding.worktreeId ||
      (binding.worktreePath !== undefined &&
        !samePath(terminal.worktreePath, binding.worktreePath)) ||
      terminal.orphaned ||
      !terminal.connected
    ) {
      throw new Error(
        `Orca terminal identity changed or disconnected for job ${jobId}; refusing control.`,
      );
    }
    return binding;
  }
}
