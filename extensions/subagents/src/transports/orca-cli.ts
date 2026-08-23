import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import type { SemanticStatus } from "../subagent-monitor.ts"
import { buildSubagentExecutionPrompt } from "../prompt.ts"

const execFile = promisify(execFileCallback)
const MAX_OUTPUT_BYTES = 256 * 1024

export interface OrcaCliResult<T> {
  readonly ok: boolean
  readonly result?: T
}

export interface OrcaCreatedTerminal {
  readonly handle: string
  readonly worktreeId?: string
  readonly tabId?: string
  readonly paneKey?: string
  readonly sessionId?: string
  readonly launchToken?: string
}

export interface OrcaCreatedPiWorktree {
  readonly id: string
  readonly path: string
  readonly branch: string
  readonly repoId: string
  readonly terminalHandle: string
  readonly terminal: OrcaCreatedTerminal
}

export interface OrcaTerminal {
  readonly handle: string
  readonly worktreeId: string
  readonly worktreePath?: string
  readonly tabId?: string
  readonly paneKey?: string
  readonly sessionId?: string
  readonly launchToken?: string
  readonly title?: string
  readonly connected: boolean
  readonly writable: boolean
  readonly orphaned: boolean
  readonly lastOutputAt?: number
}

export interface OrcaCommandRunner {
  run(command: string, args: ReadonlyArray<string>): Promise<string>
}

function defaultCommand() {
  const configured = process.env.ORCA_CLI_COMMAND?.trim()
  if (configured) {
    // execFile deliberately accepts an executable path only; command strings
    // with arguments would require a shell and are rejected fail-closed.
    if (/\s/.test(configured)) throw new Error("ORCA_CLI_COMMAND must be one executable path.")
    return configured
  }
  return process.platform === "linux" ? "orca-ide" : "orca"
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:token|secret|password|credential)=\S+/gi, "$1=[redacted]")
    .slice(0, 2_000)
}

function samePath(left: string | undefined, right: string) {
  if (!left) return false
  const normalize = (value: string) => {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function parseEnvelope<T>(raw: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Orca CLI returned malformed JSON.")
  }
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new Error("Orca CLI returned an unsupported response.")
  }
  const envelope = parsed as OrcaCliResult<T>
  if (envelope.ok !== true || envelope.result === undefined) {
    throw new Error("Orca CLI did not complete the operation.")
  }
  return envelope.result
}

function asTerminal(value: unknown): OrcaTerminal | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.handle !== "string"
    || typeof record.worktreeId !== "string"
    || typeof record.connected !== "boolean"
    || typeof record.writable !== "boolean"
    || typeof record.orphaned !== "boolean"
  ) return undefined
  return {
    handle: record.handle,
    worktreeId: record.worktreeId,
    connected: record.connected,
    writable: record.writable,
    orphaned: record.orphaned,
    ...(typeof record.worktreePath === "string" ? { worktreePath: record.worktreePath } : {}),
    ...(typeof record.tabId === "string" ? { tabId: record.tabId } : {}),
    ...(typeof record.paneKey === "string" ? { paneKey: record.paneKey } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.launchToken === "string" ? { launchToken: record.launchToken } : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.lastOutputAt === "number" ? { lastOutputAt: record.lastOutputAt } : {}),
  }
}

export class OrcaCli implements OrcaCommandRunner {
  readonly command: string

  constructor(command = defaultCommand()) {
    this.command = command
  }

  async run(command: string, args: ReadonlyArray<string>) {
    try {
      const { stdout } = await execFile(command, [...args], {
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
      })
      return stdout
    } catch (error) {
      throw new Error(`Orca CLI failed: ${boundedError(error)}`)
    }
  }

  async createPiTerminal(options: { readonly worktreePath: string; readonly mode?: "scout" | "build" }): Promise<OrcaCreatedTerminal> {
    const command = options.mode === "scout" ? "pi --tools read" : "pi"
    const result = parseEnvelope<Record<string, unknown>>(await this.run(this.command, [
      "terminal", "create", "--worktree", `path:${options.worktreePath}`, "--command", command, "--json",
    ]))
    const terminal = result.terminal as Record<string, unknown> | undefined
    const handle = typeof result.handle === "string"
      ? result.handle
      : typeof terminal?.handle === "string" ? terminal.handle : undefined
    if (!handle) throw new Error("Orca CLI did not return a terminal handle.")
    const worktreeId = typeof result.worktreeId === "string"
      ? result.worktreeId
      : typeof terminal?.worktreeId === "string" ? terminal.worktreeId : undefined
    const tabId = typeof result.tabId === "string"
      ? result.tabId
      : typeof terminal?.tabId === "string" ? terminal.tabId : undefined
    const paneKey = typeof result.paneKey === "string"
      ? result.paneKey
      : typeof terminal?.paneKey === "string" ? terminal.paneKey : undefined
    const sessionId = typeof result.sessionId === "string"
      ? result.sessionId
      : typeof result.nativeSessionId === "string"
        ? result.nativeSessionId
        : typeof terminal?.sessionId === "string" ? terminal.sessionId : undefined
    const launchToken = typeof result.launchToken === "string"
      ? result.launchToken
      : typeof terminal?.launchToken === "string" ? terminal.launchToken : undefined
    return {
      handle,
      ...(worktreeId === undefined ? {} : { worktreeId }),
      ...(tabId === undefined ? {} : { tabId }),
      ...(paneKey === undefined ? {} : { paneKey }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(launchToken === undefined ? {} : { launchToken }),
    }
  }

  async createPiWorktree(options: {
    readonly repoPath: string
    readonly name: string
    readonly prompt: string
    readonly mode?: "scout" | "build"
  }): Promise<OrcaCreatedPiWorktree> {
    if (options.mode === "scout") return this.createPiScoutWorktree(options)
    const prompt = buildSubagentExecutionPrompt({
      mode: "build",
      title: options.name,
      prompt: options.prompt,
    })
    const result = parseEnvelope<Record<string, unknown>>(await this.run(this.command, [
      "worktree", "create", "--repo", `path:${options.repoPath}`, "--name", options.name,
      "--agent", "pi", "--prompt", prompt, "--setup", "inherit", "--json",
    ]))
    const worktree = result.worktree as Record<string, unknown> | undefined
    const startupTerminal = result.startupTerminal as Record<string, unknown> | undefined
    const terminalHandle = typeof result.agentTerminalHandle === "string"
      ? result.agentTerminalHandle
      : startupTerminal?.handle
    if (
      !worktree
      || typeof worktree.id !== "string"
      || typeof worktree.path !== "string"
      || typeof worktree.branch !== "string"
      || typeof worktree.repoId !== "string"
      || typeof terminalHandle !== "string"
    ) {
      throw new Error("Orca CLI did not return a Pi worktree and terminal handle.")
    }
    const terminal: OrcaCreatedTerminal = {
      handle: terminalHandle,
      worktreeId: worktree.id,
      ...(typeof result.tabId === "string" ? { tabId: result.tabId } : typeof startupTerminal?.tabId === "string" ? { tabId: startupTerminal.tabId } : {}),
      ...(typeof result.paneKey === "string" ? { paneKey: result.paneKey } : typeof startupTerminal?.paneKey === "string" ? { paneKey: startupTerminal.paneKey } : {}),
      ...(typeof result.sessionId === "string" ? { sessionId: result.sessionId } : typeof startupTerminal?.sessionId === "string" ? { sessionId: startupTerminal.sessionId } : {}),
      ...(typeof result.launchToken === "string" ? { launchToken: result.launchToken } : typeof startupTerminal?.launchToken === "string" ? { launchToken: startupTerminal.launchToken } : {}),
    }
    return {
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      repoId: worktree.repoId,
      terminalHandle,
      terminal,
    }
  }

  private async createPiScoutWorktree(options: {
    readonly repoPath: string
    readonly name: string
    readonly prompt: string
  }): Promise<OrcaCreatedPiWorktree> {
    const created = parseEnvelope<Record<string, unknown>>(await this.run(this.command, [
      "worktree", "create", "--repo", `path:${options.repoPath}`, "--name", options.name,
      "--setup", "skip", "--json",
    ]))
    const worktree = created.worktree as Record<string, unknown> | undefined
    if (
      !worktree
      || typeof worktree.id !== "string"
      || typeof worktree.path !== "string"
      || typeof worktree.branch !== "string"
      || typeof worktree.repoId !== "string"
    ) throw new Error("Orca CLI did not return a valid scout worktree.")
    const startupTerminal = created.startupTerminal as Record<string, unknown> | undefined
    const terminalHandle = typeof created.agentTerminalHandle === "string"
      ? created.agentTerminalHandle
      : typeof startupTerminal?.handle === "string" ? startupTerminal.handle : undefined
    if (!terminalHandle) throw new Error("Orca CLI did not return a scout terminal handle.")
    const terminal: OrcaCreatedTerminal = {
      handle: terminalHandle,
      worktreeId: worktree.id,
      ...(typeof startupTerminal?.tabId === "string" ? { tabId: startupTerminal.tabId } : {}),
      ...(typeof startupTerminal?.paneKey === "string" ? { paneKey: startupTerminal.paneKey } : {}),
      ...(typeof startupTerminal?.sessionId === "string" ? { sessionId: startupTerminal.sessionId } : {}),
      ...(typeof startupTerminal?.launchToken === "string" ? { launchToken: startupTerminal.launchToken } : {}),
    }
    await this.send(terminalHandle, "pi --tools read")
    await this.waitForIdle(terminalHandle, 60_000)
    await this.send(terminalHandle, buildSubagentExecutionPrompt({
      mode: "scout",
      title: options.name,
      prompt: options.prompt,
    }))
    return {
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      repoId: worktree.repoId,
      terminalHandle,
      terminal,
    }
  }

  async removeWorktree(worktreeId: string, options: { readonly force?: boolean } = {}) {
    const args = ["worktree", "rm", "--worktree", `id:${worktreeId}`]
    if (options.force) args.push("--force")
    args.push("--json")
    await this.run(this.command, args)
  }

  async listTerminals(worktreeId?: string): Promise<ReadonlyArray<OrcaTerminal>> {
    const args = ["terminal", "list"]
    if (worktreeId) args.push("--worktree", `id:${worktreeId}`)
    args.push("--json")
    const result = parseEnvelope<{ terminals?: unknown }>(await this.run(this.command, args))
    if (!Array.isArray(result.terminals)) throw new Error("Orca CLI returned no terminal list.")
    return result.terminals.map(asTerminal).filter((item): item is OrcaTerminal => !!item)
  }

  async read(terminalHandle: string, options: { cursor?: number; limit?: number } = {}) {
    const args = ["terminal", "read", "--terminal", terminalHandle]
    if (options.cursor !== undefined) args.push("--cursor", String(options.cursor))
    if (options.limit !== undefined) args.push("--limit", String(options.limit))
    args.push("--json")
    const result = parseEnvelope<unknown>(await this.run(this.command, args))
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Orca CLI returned an unsupported terminal read.")
    }
    // Terminal text is untrusted and may contain secrets; callers must not log
    // it or use it as lifecycle evidence without an explicit parser.
    return result as Readonly<Record<string, unknown>>
  }

  async send(terminalHandle: string, text: string) {
    await this.run(this.command, ["terminal", "send", "--terminal", terminalHandle, "--text", text, "--enter", "--json"])
  }

  async waitForIdle(terminalHandle: string, timeoutMs: number) {
    await this.run(this.command, [
      "terminal", "wait", "--terminal", terminalHandle, "--for", "tui-idle",
      "--timeout-ms", String(timeoutMs), "--json",
    ])
  }

  async close(terminalHandle: string) {
    await this.run(this.command, ["terminal", "close", "--terminal", terminalHandle, "--json"])
  }

  async stop(worktreeId: string) {
    await this.run(this.command, ["terminal", "stop", "--worktree", `id:${worktreeId}`, "--json"])
  }
}

export interface OrcaTerminalBinding {
  readonly jobId: string
  readonly terminalHandle: string
  readonly worktreeId: string
  readonly worktreePath?: string
}

export interface OrcaTerminalEvidence {
  readonly jobId: string
  readonly status: SemanticStatus
  readonly source: "orca-cli"
  readonly at: number
  readonly eventName: string
  readonly evidence?: string
  readonly identityVerified: boolean
}

/**
 * Typed Orca CLI adapter. It cannot infer AI idleness from terminal text, so a
 * connected terminal is `unknown`; only a disconnected/orphaned terminal is
 * classified as `dead`. All control is scoped to an explicit job binding.
 */
export class OrcaTerminalAdapter {
  private readonly bindings = new Map<string, OrcaTerminalBinding>()
  private readonly cli: Pick<OrcaCli, "listTerminals" | "read" | "send" | "waitForIdle" | "stop"> & {
    readonly close?: (terminalHandle: string) => Promise<void>
  }

  constructor(cli: Pick<OrcaCli, "listTerminals" | "read" | "send" | "waitForIdle" | "stop"> & {
    readonly close?: (terminalHandle: string) => Promise<void>
  }) {
    this.cli = cli
  }

  attach(binding: OrcaTerminalBinding) {
    if (!binding.jobId || !binding.terminalHandle || !binding.worktreeId) {
      throw new Error("Orca terminal binding requires jobId, terminalHandle, and worktreeId.")
    }
    this.bindings.set(binding.jobId, binding)
  }

  detach(jobId: string) {
    this.bindings.delete(jobId)
  }

  async probe(jobId: string, at = Date.now()): Promise<OrcaTerminalEvidence | undefined> {
    const binding = this.bindings.get(jobId)
    if (!binding) return undefined
    const terminals = await this.cli.listTerminals(binding.worktreeId)
    const terminal = terminals.find((candidate) => candidate.handle === binding.terminalHandle)
    if (!terminal || terminal.worktreeId !== binding.worktreeId || (binding.worktreePath !== undefined && !samePath(terminal.worktreePath, binding.worktreePath)) || terminal.orphaned || !terminal.connected) {
      return { jobId, status: "dead", source: "orca-cli", at, eventName: "terminal_disconnected", identityVerified: true }
    }
    return {
      jobId,
      status: "unknown",
      source: "orca-cli",
      at,
      eventName: "terminal_connected_unverified",
      evidence: "Terminal is connected, but CLI status cannot prove AI idleness.",
      identityVerified: true,
    }
  }

  async send(jobId: string, text: string) {
    const binding = await this.requireVerifiedBinding(jobId)
    await this.cli.send(binding.terminalHandle, text)
  }

  async waitForIdle(jobId: string, timeoutMs: number) {
    const binding = await this.requireVerifiedBinding(jobId)
    await this.cli.waitForIdle(binding.terminalHandle, timeoutMs)
  }

  async read(jobId: string, options: { cursor?: number; limit?: number } = {}) {
    const binding = await this.requireVerifiedBinding(jobId)
    return this.cli.read(binding.terminalHandle, options)
  }

  async stop(jobId: string) {
    const binding = await this.requireVerifiedBinding(jobId)
    if (this.cli.close) {
      await this.cli.close(binding.terminalHandle)
      return
    }
    const terminals = await this.cli.listTerminals(binding.worktreeId)
    if (terminals.filter((terminal) => terminal.worktreeId === binding.worktreeId).length !== 1) {
      throw new Error("Refusing broad Orca worktree stop while terminal ownership is ambiguous.")
    }
    await this.cli.stop(binding.worktreeId)
  }

  private async requireVerifiedBinding(jobId: string) {
    const binding = this.bindings.get(jobId)
    if (!binding) throw new Error(`No Orca terminal is attached to job ${jobId}.`)
    const terminals = await this.cli.listTerminals(binding.worktreeId)
    const terminal = terminals.find((candidate) => candidate.handle === binding.terminalHandle)
    if (!terminal || terminal.worktreeId !== binding.worktreeId || (binding.worktreePath !== undefined && !samePath(terminal.worktreePath, binding.worktreePath)) || terminal.orphaned || !terminal.connected) {
      throw new Error(`Orca terminal identity changed or disconnected for job ${jobId}; refusing control.`)
    }
    return binding
  }
}
