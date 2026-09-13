import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ValidationEvidence, WorktreeInfo, WorktreeValidationResult } from "../core/worktree.js";

export const MAX_VALIDATION_COMMANDS = 5;
export const VALIDATION_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 8_000;

/** Normalize and validate the persisted 1–5 command contract. */
export function normalizeValidationCommands(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (value.some(command => typeof command !== "string" || command.trim().length === 0)) return [];
  return value.map(command => (command as string).trim());
}

/**
 * Parse a direct executable command without invoking a shell. Quotes group
 * arguments; shell operators are passed as ordinary arguments, never executed.
 */
export function parseValidationCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (escaped) current += "\\";
  if (quote) return [];
  if (current) args.push(current);
  return args;
}

// `auth`/`token` aliases intentionally exclude `authorization`: matching
// `Authorization:` as a generic key/value pair would swallow the scheme and
// leave `Bearer <token>` to a narrower rule with the scheme preserved.
function redact(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|auth|password|passwd|secret|token)\s*[:=]\s*)(["']?)[^\s,;"']+\2/gi, "$1$2[REDACTED]$2")
    // Standard `Authorization: Bearer <token>` / `Token <token>` headers use
    // whitespace instead of `=` or `:`.
    .replace(/\b(bearer|token)\s+([A-Za-z0-9._~+\/=-]{8,})/gi, "$1 [REDACTED]")
    .replace(/\b(?:gh[opusr]|github_pat|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\bsk-(?:proj|live|test)-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bsk_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED]");
}

export function redactAndLimit(value: string): string {
  const safe = redact(value);
  return safe.length > MAX_OUTPUT_CHARS
    ? `${safe.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
    : safe;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function scopeRegex(scope: string): RegExp {
  const normalized = normalizePath(scope).toLowerCase();
  let expression = "^";
  for (let i = 0; i < normalized.length;) {
    if (normalized.startsWith("**/", i)) {
      expression += "(?:.*/)?";
      i += 3;
    } else if (normalized.startsWith("**", i)) {
      expression += ".*";
      i += 2;
    } else if (normalized[i] === "*") {
      expression += "[^/]*";
      i++;
    } else if (normalized[i] === "?") {
      expression += "[^/]";
      i++;
    } else {
      expression += normalized[i].replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`${expression}$`);
}

export function fileMatchesScope(file: string, scope: string): boolean {
  const normalizedFile = normalizePath(file).toLowerCase();
  const normalizedScope = normalizePath(scope).toLowerCase();
  if (!normalizedScope || normalizedScope === "." || normalizedScope === "**") return true;
  if (!/[?*]/.test(normalizedScope)) {
    return normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
  }
  return scopeRegex(normalizedScope).test(normalizedFile);
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout ?? "";
}

/** Return paths changed from the immutable base, including untracked files. */
export async function collectChangedFiles(pi: ExtensionAPI, worktree: WorktreeInfo): Promise<string[]> {
  const [diff, untracked] = await Promise.all([
    gitOutput(pi, worktree.path, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", worktree.baseSha]),
    gitOutput(pi, worktree.path, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...new Set(
    `${diff}\n${untracked}`
      .split(/\r?\n/)
      .map(normalizePath)
      .filter(Boolean),
  )].sort();
}

function failedResult(error: string, changedFiles: string[] = [], evidence: WorktreeValidationResult["evidence"] = []): WorktreeValidationResult {
  return { passed: false, changedFiles, evidence, error };
}

export interface ValidationRunResult {
  passed: boolean;
  evidence: ValidationEvidence[];
  error?: string;
}

/** Execute the exact persisted commands sequentially and capture safe evidence. */
export async function runValidationCommands(
  pi: ExtensionAPI,
  cwd: string,
  commands: readonly string[],
): Promise<ValidationRunResult> {
  const normalizedCommands = normalizeValidationCommands(commands);
  if (normalizedCommands.length < 1 || normalizedCommands.length > MAX_VALIDATION_COMMANDS) {
    return { passed: false, evidence: [], error: `Validation requires 1-${MAX_VALIDATION_COMMANDS} commands.` };
  }

  const evidence: ValidationEvidence[] = [];
  for (const rawCommand of normalizedCommands) {
    const startedAt = Date.now();
    const argv = parseValidationCommand(rawCommand);
    if (argv.length === 0) {
      evidence.push({
        command: redactAndLimit(rawCommand),
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: "Invalid or unterminated quoted validation command.",
        startedAt,
        finishedAt: Date.now(),
      });
      return { passed: false, evidence, error: "Validation command could not be parsed." };
    }

    try {
      const result = await pi.exec(argv[0], argv.slice(1), {
        cwd,
        timeout: VALIDATION_TIMEOUT_MS,
      });
      const timedOut = result.killed === true;
      const exitCode = typeof result.code === "number" ? result.code : null;
      const item = {
        command: redactAndLimit(rawCommand),
        exitCode,
        timedOut,
        stdout: redactAndLimit(result.stdout ?? ""),
        stderr: redactAndLimit(result.stderr ?? ""),
        startedAt,
        finishedAt: Date.now(),
      };
      evidence.push(item);
      if (timedOut || exitCode !== 0) {
        return {
          passed: false,
          evidence,
          error: timedOut
            ? `Validation timed out: ${item.command}`
            : `Validation failed with exit ${exitCode}: ${item.command}`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.push({
        command: redactAndLimit(rawCommand),
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: redactAndLimit(message),
        startedAt,
        finishedAt: Date.now(),
      });
      return { passed: false, evidence, error: `Validation command could not execute: ${redactAndLimit(message)}` };
    }
  }

  return { passed: true, evidence };
}

/**
 * Execute a ship task's checks in the isolated worktree, sequentially and
 * fail-fast. The returned evidence is safe to persist and never trusts agent
 * prose as proof of validation.
 */
export async function validateShipWorktree(
  pi: ExtensionAPI,
  worktree: WorktreeInfo,
  writeScope: readonly string[],
  commands: readonly string[],
): Promise<WorktreeValidationResult> {
  let changedFiles: string[];
  try {
    changedFiles = await collectChangedFiles(pi, worktree);
  } catch (error) {
    return failedResult(`Unable to determine changed files: ${error instanceof Error ? error.message : String(error)}`);
  }

  const outsideScope = (files: readonly string[]) => files.filter(file => !writeScope.some(scope => fileMatchesScope(file, scope)));
  const initialOutside = outsideScope(changedFiles);
  if (initialOutside.length > 0) {
    return failedResult(`Changed files outside declared write scope: ${initialOutside.join(", ")}.`, changedFiles);
  }

  const commandRun = await runValidationCommands(pi, worktree.workPath, commands);
  if (!commandRun.passed) {
    return failedResult(commandRun.error ?? "Validation failed.", changedFiles, commandRun.evidence);
  }

  try {
    changedFiles = await collectChangedFiles(pi, worktree);
  } catch (error) {
    return failedResult(`Unable to re-check changed files: ${error instanceof Error ? error.message : String(error)}`, changedFiles, commandRun.evidence);
  }
  const finalOutside = outsideScope(changedFiles);
  if (finalOutside.length > 0) {
    return failedResult(`Changed files outside declared write scope: ${finalOutside.join(", ")}.`, changedFiles, commandRun.evidence);
  }

  return { passed: true, changedFiles, evidence: commandRun.evidence };
}
