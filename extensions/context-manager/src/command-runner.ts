import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type RunnerRuntime = "shell" | "bash" | "powershell" | "javascript" | "typescript" | "python";

export interface RunScriptOptions {
  runtime: RunnerRuntime;
  script: string;
  cwd: string;
  timeoutMs: number;
  maxRawOutputChars: number;
  signal?: AbortSignal;
  onProgress?: (elapsedMs: number, outputPreview?: string) => void;
  onOutput?: (elapsedMs: number, outputPreview: string) => void;
}

export interface RunScriptResult {
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  /** Potongan terakhir stderr, dipakai saat script gagal supaya pesan error tidak tenggelam. */
  stderrTail: string;
  durationMs: number;
}

const STDERR_TAIL_CHARS = 8_000;
const STDERR_TAIL_LINES = 20;

export class ScriptCancelledError extends Error {
  readonly result: RunScriptResult;

  constructor(result: RunScriptResult) {
    super("Eksekusi dibatalkan.");
    this.name = "ScriptCancelledError";
    this.result = result;
  }
}

const PI_BINARY_PATTERN = /^pi(?:\.exe)?$/i;
const SENSITIVE_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|COOKIE|CREDENTIAL)/i;
// AUTH dicocokkan per kata: substring ikut menangkap GIT_AUTHOR_NAME/EMAIL.
const SENSITIVE_ENV_WORD_PATTERN = /(?:^|[_-])(?:O?AUTH|AUTHORIZATION)(?:$|[_-])/i;
// Bukan secret, tapi dibutuhkan git/ssh (mis. `git push` lewat SSH agent).
const ALLOWED_ENV_KEYS = new Set(["SSH_AUTH_SOCK"]);
const UNSAFE_EXEC_ENV_PATTERN = /^(?:NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|GIT_PAGER|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i;

function runtimeExecutable(): string {
  if (!PI_BINARY_PATTERN.test(basename(process.execPath))) return process.execPath;
  return process.platform === "win32" ? "node.exe" : "node";
}

export interface ShellCommand {
  command: string;
  args: string[];
}

function readShellPathSetting(): string | undefined {
  // shellPath dari settings Pi, supaya bash yang dipilih user juga dipakai di sini.
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")) as { shellPath?: unknown };
    return typeof settings.shellPath === "string" ? settings.shellPath : undefined;
  } catch {
    return undefined;
  }
}

/** Bash untuk runtime shell: `shellPath` dari settings, lalu Git for Windows. */
export function findBash(): string | undefined {
  const candidates: (string | undefined)[] = [readShellPathSetting()];
  if (process.platform === "win32") {
    candidates.push(join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin", "bash.exe"));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  return candidates.find((path): path is string => typeof path === "string" && path.length > 0 && existsSync(path));
}

/** Nama shell untuk runtime shell, dipakai di deskripsi tool. */
export function shellRuntimeName(): string {
  if (findBash()) return "bash";
  return process.platform === "win32" ? "PowerShell" : "sh";
}

export function buildPowerShellCommand(script: string): ShellCommand {
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${script}\nexit $LASTEXITCODE`],
  };
}

/**
 * Deteksi leksikal cepat apakah script menggunakan sintaks/cmdlet khas PowerShell
 * yang tidak valid di Bash.
 */
export function looksLikePowerShell(script: string): boolean {
  const psPatterns = [
    /\$(?:env:[A-Za-z_]|LASTEXITCODE|PSVersionTable|true|false|null)\b/i,
    /\b(?:Get|Set|New|Remove|Test|Start|Stop|Invoke|Out|Select|Where|Clear|Add|Copy|Move)-[A-Za-z]+\b/,
    /\b(?:ForEach-Object|Where-Object|Select-Object|Measure-Object)\b/i,
    /\[Console\]::/i,
    /\[[A-Za-z0-9_.]+(\[\])?\]::/,
    /\|\s*Out-String\b/i,
    /\|\s*ForEach\s*\{/i,
    /\|\s*Where\s*\{/i,
  ];
  return psPatterns.some((pattern) => pattern.test(script));
}

/**
 * Perintah untuk runtime shell. Tanpa bash di Windows, PowerShell dipakai dan
 * baris `exit $LASTEXITCODE` ditambahkan supaya exit code script tidak hilang.
 */
export function buildShellCommand(
  script: string,
  bashPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellCommand {
  // Jika di Windows dan script mengandung sintaks khas PowerShell, prioritaskan PowerShell
  if (platform === "win32" && looksLikePowerShell(script)) {
    return buildPowerShellCommand(script);
  }
  if (bashPath) return { command: bashPath, args: ["-c", script] };
  if (platform === "win32") {
    return buildPowerShellCommand(script);
  }
  return { command: "/bin/sh", args: ["-c", script] };
}

function commandForRuntime(runtime: RunnerRuntime, script: string): ShellCommand {
  if (runtime === "shell") return buildShellCommand(script, findBash());
  if (runtime === "bash") {
    const bash = findBash();
    if (!bash && process.platform !== "win32") {
      return { command: "/bin/bash", args: ["-c", script] };
    }
    return { command: bash ?? "bash", args: ["-c", script] };
  }
  if (runtime === "powershell") {
    return buildPowerShellCommand(script);
  }
  if (runtime === "javascript") {
    return { command: runtimeExecutable(), args: ["-e", script] };
  }
  if (runtime === "typescript") {
    return { command: runtimeExecutable(), args: ["--experimental-strip-types", "-e", script] };
  }
  return {
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-c", script],
  };
}

export function sanitizeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      ALLOWED_ENV_KEYS.has(key.toUpperCase()) || (
        !SENSITIVE_ENV_PATTERN.test(key)
        && !SENSITIVE_ENV_WORD_PATTERN.test(key)
        && !UNSAFE_EXEC_ENV_PATTERN.test(key)
      ),
    ),
  );
}

export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// Panjang disimpan terpisah: join ulang seluruh buffer per chunk membuat
// pengumpulan output kuadratik (10 MB dalam chunk 4 KB ~8 detik CPU).
export class OutputCollector {
  private readonly parts: string[] = [];
  private readonly maxChars: number;
  private length = 0;
  truncated = false;

  constructor(maxChars: number) {
    this.maxChars = maxChars;
  }

  /** Mengembalikan true kalau batas tercapai dan teks (sebagian) dibuang. */
  append(text: string): boolean {
    if (this.length >= this.maxChars) {
      if (text) this.truncated = true;
      return this.truncated;
    }
    if (this.length + text.length > this.maxChars) {
      this.parts.push(text.slice(0, this.maxChars - this.length));
      this.length = this.maxChars;
      this.truncated = true;
      return true;
    }
    this.parts.push(text);
    this.length += text.length;
    return false;
  }

  toString(): string {
    return this.parts.join("");
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  return !processGroupExists(pid);
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch { /* already exited */ }
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      let settled = false;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (fallback) clearTimeout(fallback);
        resolveKill();
      };
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        fallback = setTimeout(() => {
          try { child.kill(); } catch {}
          finish();
        }, 1_000);
        killer.once("close", (exitCode) => {
          if (exitCode !== 0) {
            try { child.kill(); } catch {}
          }
          finish();
        });
        killer.once("error", () => {
          try { child.kill(); } catch {}
          finish();
        });
      } catch {
        try { child.kill(); } catch {}
        finish();
      }
    });
    return;
  }

  try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  if (await waitForProcessGroupExit(pid, 300)) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  await waitForProcessGroupExit(pid, 500);
}

const LIVE_OUTPUT_MAX_LINES = 8;
const LIVE_OUTPUT_MAX_LINE_CHARS = 500;
const LIVE_OUTPUT_UPDATE_INTERVAL_MS = 100;

export function sanitizeTerminalOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\x5c)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export class LiveOutputBuffer {
  private readonly completedLines: string[] = [];
  private readonly currentLineChars: string[] = [];
  private currentLineStart = 0;
  private currentLineTruncated = false;
  private pendingCarriageReturn = false;
  private omittedLines = 0;

  append(text: string): void {
    for (const char of text) {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false;
        if (char === "\n") {
          this.commitLine();
          continue;
        }
        this.resetCurrentLine();
      }

      if (char === "\r") {
        this.pendingCarriageReturn = true;
      } else if (char === "\n") {
        this.commitLine();
      } else if (this.currentLineChars.length < LIVE_OUTPUT_MAX_LINE_CHARS) {
        this.currentLineChars.push(char);
      } else {
        this.currentLineChars[this.currentLineStart] = char;
        this.currentLineStart = (this.currentLineStart + 1) % LIVE_OUTPUT_MAX_LINE_CHARS;
        this.currentLineTruncated = true;
      }
    }
  }

  snapshot(): string {
    const lines = [...this.completedLines];
    const currentLine = this.getCurrentLine();
    if (currentLine || lines.length === 0) {
      lines.push(this.currentLineTruncated ? `…${currentLine}` : currentLine);
    }
    if (this.omittedLines > 0) {
      lines.unshift(`… ${this.omittedLines} earlier lines omitted`);
    }
    return sanitizeTerminalOutput(lines.join("\n"));
  }

  private getCurrentLine(): string {
    if (this.currentLineStart === 0) return this.currentLineChars.join("");
    return [
      ...this.currentLineChars.slice(this.currentLineStart),
      ...this.currentLineChars.slice(0, this.currentLineStart),
    ].join("");
  }

  private resetCurrentLine(): void {
    this.currentLineChars.length = 0;
    this.currentLineStart = 0;
    this.currentLineTruncated = false;
  }

  private commitLine(): void {
    const currentLine = this.getCurrentLine();
    this.completedLines.push(this.currentLineTruncated ? `…${currentLine}` : currentLine);
    if (this.completedLines.length > LIVE_OUTPUT_MAX_LINES) {
      this.completedLines.shift();
      this.omittedLines++;
    }
    this.resetCurrentLine();
  }
}

export async function runScript(options: RunScriptOptions): Promise<RunScriptResult> {
  if (!options.script.trim()) throw new Error("Script tidak boleh kosong.");
  if (options.signal?.aborted) {
    throw new ScriptCancelledError({
      output: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      truncated: false,
      stderrTail: "",
      durationMs: 0,
    });
  }
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs, 300_000));
  const maxRawOutputChars = Math.max(1_000, Math.min(options.maxRawOutputChars, 10 * 1024 * 1024));
  const startedAt = Date.now();
  const { command, args } = commandForRuntime(options.runtime, options.script);
  const child = spawn(command, args, {
    cwd: resolve(options.cwd),
    env: sanitizeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let processTreeKill: Promise<void> | undefined;
  const requestProcessTreeKill = () => {
    processTreeKill ??= killProcessTree(child);
    return processTreeKill;
  };
  const collector = new OutputCollector(maxRawOutputChars);
  const liveOutput = new LiveOutputBuffer();
  let timedOut = false;
  let stderrRaw = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let outputUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  let stopUpdates = false;
  let lastOutputUpdateAt = 0;
  let hasOutputPreview = false;
  const stopLiveUpdates = () => {
    stopUpdates = true;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = undefined;
    if (outputUpdateTimer) clearTimeout(outputUpdateTimer);
    outputUpdateTimer = undefined;
  };
  const emitOutputUpdate = () => {
    if (!options.onOutput || stopUpdates) return;
    lastOutputUpdateAt = Date.now();
    try {
      options.onOutput(lastOutputUpdateAt - startedAt, liveOutput.snapshot());
    } catch {
      // Progress rendering is best-effort and must not interrupt process cleanup.
    }
  };
  const scheduleOutputUpdate = () => {
    if (!options.onOutput || stopUpdates) return;
    if (!hasOutputPreview) {
      hasOutputPreview = true;
      emitOutputUpdate();
      return;
    }
    const delay = LIVE_OUTPUT_UPDATE_INTERVAL_MS - (Date.now() - lastOutputUpdateAt);
    if (delay <= 0) {
      if (outputUpdateTimer) clearTimeout(outputUpdateTimer);
      outputUpdateTimer = undefined;
      emitOutputUpdate();
    } else if (!outputUpdateTimer) {
      outputUpdateTimer = setTimeout(() => {
        outputUpdateTimer = undefined;
        emitOutputUpdate();
      }, delay);
    }
  };
  if (options.onProgress) {
    const tick = () => {
      if (stopUpdates) return;
      try {
        options.onProgress!(Date.now() - startedAt, liveOutput.snapshot());
      } catch {
        // Progress rendering is best-effort and must not interrupt process cleanup.
      }
    };
    tick();
    progressTimer = setInterval(tick, LIVE_OUTPUT_UPDATE_INTERVAL_MS);
  }

  const abort = () => {
    if (!settled && !stopUpdates) {
      stopLiveUpdates();
      void requestProcessTreeKill();
    }
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolveResult, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      stopLiveUpdates();
      void requestProcessTreeKill();
    }, timeoutMs);
    // Satu decoder per stream: karakter multi-byte yang terbelah di dua chunk
    // tetap utuh, dan stdout/stderr tidak saling menyambung byte parsial.
    const handleText = (text: string) => {
      if (!text) return;
        // Output berlebih hanya dibuang. Proses dibiarkan selesai, dibatasi timeout.
      collector.append(text);
      if (options.onProgress || options.onOutput) {
        liveOutput.append(text);
        scheduleOutputUpdate();
      }
    };
    const handleStderr = (text: string) => {
      stderrRaw = (stderrRaw + text).slice(-STDERR_TAIL_CHARS);
      handleText(text);
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => handleText(stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => handleStderr(stderrDecoder.write(chunk)));
    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
      stopLiveUpdates();
      void requestProcessTreeKill();
    });
    child.once("close", (exitCode, signal) => {
      handleText(stdoutDecoder.end());
      handleStderr(stderrDecoder.end());
      if (outputUpdateTimer && !stopUpdates) {
        clearTimeout(outputUpdateTimer);
        outputUpdateTimer = undefined;
        emitOutputUpdate();
      }
      stopLiveUpdates();
      if (processError && !options.signal?.aborted) reject(processError);
      else resolveResult({ exitCode, signal });
    });
  }).finally(async () => {
    settled = true;
    if (timer) clearTimeout(timer);
    stopLiveUpdates();
    options.signal?.removeEventListener("abort", abort);
    if (processTreeKill) await processTreeKill;
  });

  const truncated = collector.truncated;
  let output = collector.toString();
  if (truncated) output += "\n[context-manager] Raw output dipotong setelah batas cache tercapai.";
  const runResult: RunScriptResult = {
    output,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    truncated,
    stderrTail: stderrRaw.split(/\r?\n/).filter((line) => line.trim()).slice(-STDERR_TAIL_LINES).join("\n"),
    durationMs: Date.now() - startedAt,
  };
  if (options.signal?.aborted) throw new ScriptCancelledError(runResult);
  return runResult;
}
