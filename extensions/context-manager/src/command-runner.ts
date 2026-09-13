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
  onProgress?: (elapsedMs: number) => void;
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
const SENSITIVE_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|COOKIE|CREDENTIAL)/i;
const UNSAFE_EXEC_ENV_PATTERN = /^(?:NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|GIT_PAGER|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i;

function runtimeExecutable(): string {
  if (!PI_BINARY_PATTERN.test(basename(process.execPath))) return process.execPath;
  return process.platform === "win32" ? "node.exe" : "node";
}

function commandForRuntime(runtime: RunnerRuntime, script: string): { command: string; args: string[] } {
  if (runtime === "shell") {
    return process.platform === "win32"
      ? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script] }
      : { command: "/bin/sh", args: ["-c", script] };
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
      !SENSITIVE_ENV_PATTERN.test(key) && !UNSAFE_EXEC_ENV_PATTERN.test(key),
    ),
  );
}

// ponytail: allowlist sederhana read-only (tanpa dep) — akurat untuk pola umum; upgrade ke shell-quote/shlex hanya bila butuh AST komplit (mis. nested subshell, $() kompleks) dan usage >80% sering.
const READONLY_SHELL_SEGMENT_PATTERNS: RegExp[] = [
  /^\s*(ls|dir|pwd|whoami|cat|type|head|tail|less|more|wc|sort|uniq|cut|awk|sed|jq|yq|tree|stat|file|du|df|printenv|uname|date|which|where|ping|sleep|ver)\b/i,
  /^\s*(grep|rg|ag|find|fd|git)\b/i,
  /^\s*(npm|pnpm|yarn|bun)\b/i,
  /^\s*(node|python3?|python|deno|bun)\s+(--version|-v)\s*$/i,
  /^\s*echo\b/i,
  /^\s*printf\b/i,
];

const READONLY_GIT_SUBCOMMAND = /^(status|diff|log|show|remote|rev-parse|ls-files|ls-remote|tag|describe|shortlog|blame)\b/i;
const READONLY_GIT_BRANCH_ARGS = /^branch\b(?:\s+(?:--[a-z-]+|-[a-z]+|\S+))*\s*$/i;
const READONLY_NPM_SUBCOMMAND = /^(list|ls|view|outdated|why|explain|help)\b/i;

// ponytail: heuristik substring konservatif untuk js/ts/py — arah aman: false positive = minta konfirmasi, bukan lolos.
// read-only = komputasi murni tanpa IO/side-effect (mis. 1+1, JSON.parse, math, print). Upgrade path: AST parse bila heuristik terlalu berisik.
const MUTATING_JS_PATTERN = /require\s*\(|\bimport\b|from\s+['"]|child_process|worker_threads|\bcluster\b|\bfs\b|\bos\b|\bpath\b|\bnet\b|\bhttp\b|\bdgram\b|\bdns\b|\btls\b|\bstream\b|\bvm\b|\binspector\b|\brepl\b|\breadline\b|process\s*\.|\bDeno\b|\bBun\b|globalThis|\bglobal\s*\.|\bself\s*\.|\bwindow\b|\bdocument\b|\bnavigator\b|localStorage|sessionStorage|indexedDB|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\beval\s*\(|new\s+Function|\bspawn\b|\bexecFile\b|\bexecSync\b|\bspawnSync\b|\bfork\s*\(|writeFile|appendFile|\bmkdir\b|\brmdir\b|\bunlink\b|\brename\b|copyFile|\btruncate\b|\bchmod\b|\bchown\b|createWriteStream|\.write\s*\(/i;

const MUTATING_PY_PATTERN = /__import__|\bimport\b|\beval\s*\(|\bexec\s*\(|\bcompile\s*\(|\bopen\s*\([^,]*,\s*['"][^'"]*[wax+]|\binput\s*\(|\bexit\b|\bquit\b|\bos\b|\bsys\b|\bsubprocess\b|\bshutil\b|\bpathlib\b|\bsocket\b|\bhttp\b|\burllib\b|\brequests\b|\bctypes\b|\bmultiprocessing\b|\bthreading\b|\bconcurrent\b|\bimportlib\b|\bpkgutil\b|\bsite\b|\bpty\b|\btty\b|\btermios\b|\bfcntl\b|\bsignal\b|\bssl\b|\bftplib\b|\bsmtplib\b|\btelnetlib\b|\bwebbrowser\b|\bsystem\b|\bpopen\b|\bspawn\w*|\.write\s*\(|\.writelines|file\s*=/i;

function isMutatingCodeScript(runtime: RunnerRuntime, script: string): boolean {
  if (runtime === "python") return MUTATING_PY_PATTERN.test(script);
  return MUTATING_JS_PATTERN.test(script);
}

function stripQuoted(script: string): string {
  return script.replaceAll(/'[^']*'|"[^"]*"/g, (m) => " ".repeat(m.length));
}
function hasShellExpansion(script: string): boolean {
  return /\$\(|\$\(\(|`/.test(script)
    || /\$\{[^}]*\}/.test(script)
    || /(^|[^\\])\$[A-Za-z_][A-Za-z0-9_]*/.test(script);
}

function containsOutsideCwdReference(script: string): boolean {
  // The shell runner is project-local by contract. A conservative lexical
  // guard prevents the read-only allowlist from becoming a read primitive for
  // /etc, $HOME, another drive, or a parent directory. Scripts that genuinely
  // need those paths are classified as mutating and require confirmation.
  return /(?:^|[\s"'(=])(?:~(?:[\\/]|$)|[\\/]{1,2}|[A-Za-z]:[\\/]|\.\.(?:[\\/]|$))/.test(script);
}

function containsRedirection(script: string): boolean {
  // ponytail: treat any bare `>` as redirection (covers >, >>, 2>, 2>>, &>, >&); quoted `>` stripped above.
  return stripQuoted(script).includes(">");
}

function isReadOnlyShellSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  if (hasShellExpansion(trimmed)) return false;
  if (containsOutsideCwdReference(trimmed)) return false;
  if (containsRedirection(trimmed)) return false;
  if (/\b(tee|Set-Content|Out-File)\b/i.test(trimmed)) return false;
  if (/^\s*find\b/i.test(trimmed) && /(?:^|\s)-(?:exec|execdir|delete|ok|okdir)\b/i.test(trimmed)) return false;
  if (/^\s*awk\b/i.test(trimmed) && (/\bsystem\s*\(/i.test(trimmed) || />/.test(trimmed))) return false;
  if (/^\s*sed\b/i.test(trimmed) && /(?:^|\s)(?:-i|--in-place)(?:\s|=|$)/i.test(trimmed)) return false;
  if (/^\s*git\b/i.test(trimmed) && /(?:--output(?:=|\s)|--ext-diff\b)/i.test(trimmed)) return false;
  const matchesAllowlist = READONLY_SHELL_SEGMENT_PATTERNS.some((re) => re.test(trimmed));
  if (!matchesAllowlist) return false;
  if (/^\s*git\b/i.test(trimmed)) {
    const after = trimmed.replace(/^\s*git\s+/i, "");
    if (/^branch\b/i.test(after)) {
      if (!READONLY_GIT_BRANCH_ARGS.test(after)) return false;
      if (/\s-D\b|\s--delete\b|\s-d\b|\s-m\b|\s--move\b|\s-c\b|\s--copy\b/i.test(` ${after}`)) return false;
    } else if (!READONLY_GIT_SUBCOMMAND.test(after)) return false;
    if (/^remote\b/i.test(after) && !/^remote(?:\s+(?:-v|--verbose))?\s*$/i.test(after)) return false;
    if (/^tag\b/i.test(after) && !/^tag(?:\s+(?:-l|--list)\b.*)?\s*$/i.test(after)) return false;
  }
  if (/^\s*(npm|pnpm|yarn|bun)\b/i.test(trimmed)) {
    const after = trimmed.replace(/^\s*(npm|pnpm|yarn|bun)\s+/i, "");
    if (!after.trim()) return false;
    if (/\baudit\b/i.test(after) && /\bfix\b/i.test(after)) return false;
    if (!READONLY_NPM_SUBCOMMAND.test(after)) return false;
  }
  if (/^\s*([./]|[A-Za-z]:[\\/])[^;&|\n]*\.(sh|bash|zsh|ps1|bat|cmd|py|js|ts)\b/i.test(trimmed)) return false;
  if (/^\s*(bash|sh|zsh|fish|pwsh|powershell|python3?|node|deno|bun)(\s+.*)?$/i.test(trimmed)) {
    if (!/^\s*(node|python3?|python|deno|bun)\s+(--version|-v)\b/i.test(trimmed)) return false;
  }
  return true;
}

function isReadOnlyShellScript(script: string): boolean {
  const segments = script.split(/(?:&&|\|\||;|\n|\|)/g);
  return segments.every((seg) => isReadOnlyShellSegment(seg));
}

export function isPotentiallyMutating(runtime: RunnerRuntime, script: string): boolean {
  if (!script.trim()) return true;
  if (runtime === "shell") return !isReadOnlyShellScript(script);
  return isMutatingCodeScript(runtime, script);
}

export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function appendOutput(parts: string[], chunk: Buffer, maxChars: number): boolean {
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

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch { /* already exited */ }
    return;
  }
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.unref?.();
      setTimeout(() => { try { child.kill(); } catch {} }, 500);
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      setTimeout(() => {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        try { child.kill("SIGKILL"); } catch {}
      }, 300);
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

function killChild(child: ChildProcess): void { killProcessTree(child); }

export async function runScript(options: RunScriptOptions): Promise<RunScriptResult> {
  if (!options.script.trim()) throw new Error("Script tidak boleh kosong.");
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
  const parts: string[] = [];
  let truncated = false;
  let timedOut = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (options.onProgress) {
    const tick = () => options.onProgress!(Date.now() - startedAt);
    tick();
    progressTimer = setInterval(tick, 100);
  }

  const abort = () => {
    if (!settled) killProcessTree(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolveResult, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (appendOutput(parts, chunk, maxRawOutputChars)) {
        truncated = true;
        killProcessTree(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (appendOutput(parts, chunk, maxRawOutputChars)) {
        truncated = true;
        killProcessTree(child);
      }
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal }));
  }).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
    if (progressTimer) clearInterval(progressTimer);
    options.signal?.removeEventListener("abort", abort);
  });

  if (options.signal?.aborted) throw new Error("Eksekusi dibatalkan.");
  if (truncated) parts.push("\n[context-manager] Raw output dipotong setelah batas cache tercapai.");
  return {
    output: parts.join(""),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
