import { spawn, type ChildProcess } from "node:child_process";
import { basename, resolve } from "node:path";

export type RunnerRuntime = "shell" | "javascript" | "typescript" | "python";

export interface RunScriptOptions {
  runtime: RunnerRuntime;
  script: string;
  cwd: string;
  timeoutMs: number;
  maxRawOutputChars: number;
  signal?: AbortSignal;
}

export interface RunScriptResult {
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const PI_BINARY_PATTERN = /^pi(?:\.exe)?$/i;
const SENSITIVE_ENV_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|COOKIE|CREDENTIAL)/i;

function runtimeExecutable(): string {
  if (!PI_BINARY_PATTERN.test(basename(process.execPath)))
    return process.execPath;
  return process.platform === "win32" ? "node.exe" : "node";
}

function commandForRuntime(
  runtime: RunnerRuntime,
  script: string,
): { command: string; args: string[] } {
  if (runtime === "shell") {
    return process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
          ],
        }
      : { command: "/bin/sh", args: ["-c", script] };
  }
  if (runtime === "javascript") {
    return { command: runtimeExecutable(), args: ["-e", script] };
  }
  if (runtime === "typescript") {
    return {
      command: runtimeExecutable(),
      args: ["--experimental-strip-types", "-e", script],
    };
  }
  return {
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-c", script],
  };
}

export function sanitizeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !SENSITIVE_ENV_PATTERN.test(key)),
  );
}

const MUTATING_SHELL_PATTERN =
  /(?:^|[\s;&|])(?:rm|del|erase|mv|move|cp|copy|mkdir|rmdir|chmod|chown|Remove-Item|Set-Content|Out-File|tee)\b|(?:^|[\s;&|])(?:git\s+(?:reset|clean|checkout|commit|merge))\b|(?:^|[\s;&|])(?:npm|pnpm|yarn)\s+(?:install|i|update|uninstall)\b|(?:^|[\s;&|])(?:migrate|migration|deploy|terraform\s+apply|kubectl\s+apply|docker\s+push)\b|(?:^|[\s;&|])(?:bash|sh|zsh|fish|pwsh|powershell|python3?|node|deno|bun)(?:\s+-File)?\s+(?:-e\s+)?(?:[./~]|[A-Za-z]:[\\/])|(?:^|[\s;&|])(?:[./\\]|[A-Za-z]:[\\/])[^;&|\n]*\.(?:sh|bash|zsh|ps1|bat|cmd|py|js|ts)\b/i;

export function isPotentiallyMutating(
  runtime: RunnerRuntime,
  script: string,
): boolean {
  if (runtime !== "shell") return true;
  return MUTATING_SHELL_PATTERN.test(script);
}

function appendOutput(
  parts: string[],
  chunk: Buffer,
  maxChars: number,
): boolean {
  const text = chunk.toString("utf8");
  const current = parts.join("");
  if (current.length >= maxChars) return true;
  if (current.length + text.length > maxChars) {
    parts.push(text.slice(0, maxChars - current.length));
    return true;
  }
  parts.push(text);
  return false;
}

function killChild(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Ignore a process that already exited.
  }
}

export async function runScript(
  options: RunScriptOptions,
): Promise<RunScriptResult> {
  if (!options.script.trim()) throw new Error("Script tidak boleh kosong.");
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs, 300_000));
  const maxRawOutputChars = Math.max(
    1_000,
    Math.min(options.maxRawOutputChars, 10 * 1024 * 1024),
  );
  const startedAt = Date.now();
  const { command, args } = commandForRuntime(options.runtime, options.script);
  const child = spawn(command, args, {
    cwd: resolve(options.cwd),
    env: sanitizeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const parts: string[] = [];
  let truncated = false;
  let timedOut = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = () => {
    if (!settled) killChild(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const result = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolveResult, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (appendOutput(parts, chunk, maxRawOutputChars)) {
        truncated = true;
        killChild(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (appendOutput(parts, chunk, maxRawOutputChars)) {
        truncated = true;
        killChild(child);
      }
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolveResult({ exitCode, signal }),
    );
  }).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  });

  if (options.signal?.aborted) throw new Error("Eksekusi dibatalkan.");
  if (truncated)
    parts.push(
      "\n[context-manager] Raw output dipotong setelah batas cache tercapai.",
    );
  return {
    output: parts.join(""),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
