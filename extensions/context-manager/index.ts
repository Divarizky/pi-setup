import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isInsideProject } from "./src/security.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  findSnippets,
  formatLineRange,
  formatSummary,
  summarizeOutput,
} from "./src/context-summary.ts";
import {
  createContextStats,
  formatContextStats,
  recordPrune,
  recordHighContext,
  recordRetrieval,
  estimateTokens,
  recordSummary,
} from "./src/context-stats.ts";
import { OutputCache } from "./src/output-cache.ts";
import { formatContextPercent, selectCompressionMode } from "./src/context-policy.ts";
import {
  applyBudgetEnvironmentOverride,
  loadContextManagerConfig,
  MAX_CONTEXT_BUDGET_PERCENT,
  MAX_OUTPUT_CHAR_THRESHOLD,
  MAX_OUTPUT_LINE_THRESHOLD,
  MIN_CONTEXT_BUDGET_PERCENT,
  MIN_OUTPUT_CHAR_THRESHOLD,
  MIN_OUTPUT_LINE_THRESHOLD,
  resetContextManagerConfig,
  saveContextManagerConfig,
  type ContextManagerConfig,
} from "./src/context-config.ts";
import {
  formatElapsed,
  isPotentiallyMutating,
  runScript,
  type RunnerRuntime,
} from "./src/command-runner.ts";

const MAX_INSPECT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXECUTION_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTION_OUTPUT_CHARS = 5_000;
const MAX_EXECUTION_TIMEOUT_MS = 300_000;
const MAX_EXECUTION_OUTPUT_CHARS = 100_000;
// tool_result coverage: beberapa versi Pi pakai nama berbeda
const LARGE_OUTPUT_TOOL_NAMES = new Set(["read", "bash", "powershell", "grep", "read_file", "shell"]);

// config cache: baca sync tiap tool_result/context blokir loop; cache 2s + invalidate on save/reset
let cachedConfig: ContextManagerConfig | null = null;
let cachedConfigAt = 0;
const CONFIG_CACHE_TTL_MS = 2_000;
function currentContextManagerConfig(): ContextManagerConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfigAt < CONFIG_CACHE_TTL_MS) return cachedConfig;
  cachedConfig = applyBudgetEnvironmentOverride(loadContextManagerConfig());
  cachedConfigAt = now;
  return cachedConfig;
}
function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedConfigAt = 0;
}

function formatConfig(config: ContextManagerConfig): string {
  return `Threshold: ${config.outputCharThreshold.toLocaleString("id-ID")} karakter / ${config.outputLineThreshold.toLocaleString("id-ID")} baris; budget output tool: ${config.contextBudgetPercent}% context window.`;
}

function formatConfigValue(label: string, config: ContextManagerConfig): string {
  if (label === "Threshold karakter") return `${config.outputCharThreshold.toLocaleString("id-ID")} karakter`;
  if (label === "Threshold baris") return `${config.outputLineThreshold.toLocaleString("id-ID")} baris`;
  if (label === "Budget output tool") return `${config.contextBudgetPercent}%`;
  if (label === "Budget context") return `${config.contextBudgetPercent}%`;
  return "";
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || !("type" in part)) return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

type ReminderLevel = "below" | "moderate" | "compact" | "unknown";
interface ReminderState {
  level: ReminderLevel;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function contextReminderLevel(percent: number | null | undefined): ReminderLevel {
  if (percent === null || percent === undefined) return "unknown";
  if (percent <= 30) return "below";
  if (percent <= 60) return "moderate";
  return "compact";
}

function updateContextReminder(ctx: ExtensionContext, state: ReminderState & { lastNotifiedAt?: number }) {
  const percent = ctx.getContextUsage()?.percent;
  const level = contextReminderLevel(percent);
  if (level === state.level && level !== "unknown") return;
  state.level = level;

  if (level === "below" || level === "unknown") return;

  const now = Date.now();
  if (state.lastNotifiedAt && now - state.lastNotifiedAt < 30_000) return;
  state.lastNotifiedAt = now;

  notify(
    ctx,
    `[Context Manager] penggunaan context ${formatContextPercent(percent)}%. Output berikutnya akan diringkas`,
    "warning",
  );
}

function parseConfigInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}


let lastPrunePrefixDirty = false;


const PI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Partial render pakai Text(0,0) seperti renderCall agar sejajar dengan baris
// perintah. Loader Pi render di dalam Box(1,1) sehingga indent 2 spasi.
// Frame spinner dipilih dari elapsed (tick onUpdate 100ms) — animasi kasar
// tanpa interval sendiri, tanpa rantai requestRender → invalidate sinkron.
function renderToolLoading(label: string, elapsedMs: number, theme: any): Text {
  const frame = PI_SPINNER_FRAMES[Math.floor(elapsedMs / 100) % PI_SPINNER_FRAMES.length];
  return new Text(theme.fg("accent", frame) + " " + theme.fg("muted", label), 0, 0);
}

export default function (pi: ExtensionAPI) {
  let stats = createContextStats();
  const reminderState = { level: "unknown" as ReminderLevel };
  const outputCache = new OutputCache();
  const cachedToolResults = new Map<string, { outputId: string; text: string; priority: number }>();
  const prunedToolResults = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    stats = createContextStats();
    const sessionId = (()=>{ try { return (ctx.sessionManager as any).getSessionId?.(); } catch { return undefined; } })();
    const sessionFile = (()=>{ try { return (ctx.sessionManager as any).getSessionFile?.(); } catch { return undefined; } })();
    const sessionDir = (()=>{ try { return (ctx.sessionManager as any).getSessionDir?.(); } catch { return undefined; } })();
    const persistentSessionId = sessionFile ? sessionId : undefined;
    outputCache.setProjectDir(ctx.cwd, sessionDir ? join(sessionDir, "context-manager-cache") : undefined);
    outputCache.setSessionId(persistentSessionId);
    outputCache.resetSession();
    // Rekonstruksi activeIds dari branch agar resume tidak kehilangan referensi (reference-kept)
    try {
      const branch: any[] = (ctx.sessionManager as any).getBranch?.() ?? [];
      const ids: string[] = [];
      for (const e of branch) {
        const m = e as any;
        const cand = m?.message?.details?.contextManager?.outputId ?? m?.details?.contextManager?.outputId ?? m?.data?.outputId;
        if (typeof cand === "string") ids.push(cand);
      }
      await outputCache.syncSessionReferences(persistentSessionId, ids, sessionFile);
      // rekonstruksi cachedToolResults minimal agar pruning tetap konsisten setelah resume
      for (const e of branch) {
        const m = e as any;
        const tcId = m?.message?.toolCallId ?? m?.toolCallId;
        const oid = m?.message?.details?.contextManager?.outputId ?? m?.details?.contextManager?.outputId;
        if (typeof tcId === "string" && typeof oid === "string" && !cachedToolResults.has(tcId)) {
          const txt = typeof m?.message?.content === "string" ? m.message.content : Array.isArray(m?.message?.content) ? m.message.content.filter((p:any)=>p?.type==="text").map((p:any)=>p.text).join("\n") : "";
          if (txt) cachedToolResults.set(tcId, { outputId: oid, text: txt.slice(0, 8000), priority: 1 });
        }
      }
    } catch {}
    void outputCache.cleanup();
    prunedToolResults.clear();
    reminderState.level = "unknown";
    updateContextReminder(ctx, reminderState);
  });

  pi.on("turn_end", (_event, ctx) => { updateContextReminder(ctx, reminderState); });

  pi.registerTool({
    name: "execute",
    label: "Execute Context-Safe Script",
    description: "Run a general non-interactive shell or script in the project and return a compact result. Raw output is cached for later inspection. All scripts run without confirmation.",
    promptSnippet: "Run a project-local script and return only a compact, cached result",
    promptGuidelines: [
      "Prefer execute for tests, lint, builds, git inspection, and processing large outputs.",
      "Use runtime shell, javascript, typescript, or python; keep the script non-interactive.",
      "All scripts run without confirmation, including potentially mutating ones.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      runtime: Type.Optional(Type.Union([
        Type.Literal("shell"),
        Type.Literal("javascript"),
        Type.Literal("typescript"),
        Type.Literal("python"),
      ])),
      script: Type.String({ description: "Shell command or script to execute" }),
      cwd: Type.Optional(Type.String({ description: "Project-local working directory" })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_EXECUTION_TIMEOUT_MS })),
      maxOutputChars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_EXECUTION_OUTPUT_CHARS })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const runtime = (params.runtime ?? "shell") as RunnerRuntime;
      const requestedCwd = resolve(ctx.cwd, params.cwd ?? ".");
      const [realRequestedCwd, realProjectCwd] = await Promise.all([
        realpath(requestedCwd).catch(() => requestedCwd),
        realpath(ctx.cwd).catch(() => ctx.cwd),
      ]);
      if (!isInsideProject(realProjectCwd, realRequestedCwd)) {
        throw new Error("execute hanya boleh bekerja di dalam current project.");
      }

      // Approval gate dihapus per permintaan user: semua script jalan tanpa
      // konfirmasi, termasuk yang mutatif dan mode headless. Batas aman sisa:
      // isInsideProject (cwd), sanitizeEnvironment, timeout + kill tree.
      void isPotentiallyMutating;

      // Revalidate cwd
      const [verifiedCwd, verifiedProjectCwd] = await Promise.all([
        realpath(requestedCwd).catch(() => requestedCwd),
        realpath(ctx.cwd).catch(() => ctx.cwd),
      ]);
      if (
        verifiedCwd !== realRequestedCwd ||
        !isInsideProject(verifiedProjectCwd, verifiedCwd)
      ) {
        throw new Error("current project berubah setelah validasi; execute dibatalkan.");
      }

      let lastSent = "";
      const sendProgress = (elapsedMs: number) => {
        const label = `execute · ${formatElapsed(elapsedMs)}`;
        if (label === lastSent) return;
        lastSent = label;
        try {
          onUpdate?.({
            content: [{ type: "text", text: label }],
            details: { contextManager: { elapsedMs, running: true } },
          });
        } catch { /* onUpdate opsional; abaikan */ }
      };
      const result = await runScript({
        runtime,
        script: params.script,
        cwd: verifiedCwd,
        timeoutMs: params.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        maxRawOutputChars: MAX_EXECUTION_OUTPUT_BYTES,
        signal,
        onProgress: onUpdate ? sendProgress : undefined,
      });
      const raw = result.output || "[no output]";
      const outputId = await outputCache.save(raw);
      const config = currentContextManagerConfig();
      if (raw.length >= config.outputCharThreshold || raw.split(/\r?\n/).length >= config.outputLineThreshold) {
        notify(ctx, "[Context Manager] output besar dari execute diringkas.");
      }
      const status = result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "success"
          : `failed (exit ${result.exitCode ?? "unknown"})`;
      const summary = formatSummary(
        summarizeOutput(raw, 2),
        `dari execute (${runtime})`,
        `Gunakan inspect dengan outputId "${outputId}" dan query untuk mengambil raw output yang relevan.`,
      );
      const header = `[context-manager] Status: ${status}; durasi: ${formatElapsed(result.durationMs)}. | outputId: "${outputId}" | inspect: { outputId: "${outputId}", query: "<kata>" }`;
      const maxOutputChars = Math.max(
        1_000,
        Math.min(params.maxOutputChars ?? DEFAULT_EXECUTION_OUTPUT_CHARS, MAX_EXECUTION_OUTPUT_CHARS),
      );
      // header pinned: jangan potong baris pertama agar outputId selalu ada
      const bodyMax = Math.max(200, maxOutputChars - header.length - 80);
      const boundedBody = summary.length > bodyMax
        ? `${summary.slice(0, bodyMax)}\n[context-manager] Summary dipotong; gunakan outputId untuk detail.`
        : summary;
      const output = [header, boundedBody].join("\n");
      const boundedOutput = output;
      recordSummary(stats, raw, boundedOutput);
      cachedToolResults.set(toolCallId, {
        outputId,
        text: boundedOutput,
        priority: result.exitCode === 0 && !result.timedOut ? 1 : 2,
      });
      // Kontrak Pi: error = throw, bukan isError pada return sukses (wrapper mengeset isError=false untuk return).
      if (result.timedOut || result.exitCode !== 0) {
        const err: any = new Error(boundedOutput);
        (err as any).details = { contextManager: { outputId, runtime, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs } };
        // Pi membaca thrown error message sebagai content + isError=true; tetap pertahankan outputId lewan details merge di afterToolCall
        throw err;
      }
      return {
        content: [{ type: "text", text: boundedOutput }],
        details: {
          contextManager: { outputId, runtime, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs },
        },
      };
    },
    renderCall(args, theme, _context) {
      const arrow = theme.fg("toolTitle", "▶ ");
      const one = String(args.script ?? "").trim().split(String.fromCharCode(10))[0]?.split(String.fromCharCode(13))[0] ?? "";
      const preview = one.length > 72 ? one.slice(0, 71) + "…" : one;
      const rt = String(args.runtime ?? "shell");
      let line = arrow + theme.fg("toolTitle", theme.bold("execute")) + " " + theme.fg("muted", rt + " · ") + theme.fg("dim", preview || "(no script)");
      return new Text(line, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, _context) {
      const d = result.details as { contextManager?: { outputId?: string; runtime?: string; exitCode?: number | null; timedOut?: boolean; durationMs?: number; elapsedMs?: number } } | undefined;
      const cm = d?.contextManager;
      const failed = Boolean((result as any).isError) || cm?.timedOut === true || (cm?.exitCode != null && cm.exitCode !== 0);
      const status = cm?.timedOut ? "timeout" : cm?.exitCode != null && cm.exitCode !== 0 ? "failed (exit " + cm.exitCode + ")" : failed ? "failed" : "success";
      const dur = cm?.durationMs != null ? ` · ${formatElapsed(cm.durationMs)}` : "";
      if (isPartial) {
        const c0 = result.content[0];
        const label = c0?.type === "text" && String(c0.text).trim()
          ? String(c0.text).trim()
          : "execute";
        return renderToolLoading(label, cm?.elapsedMs ?? 0, theme);
      }
      const c0 = result.content[0];
      const raw = c0?.type === "text" ? String(c0.text) : "";
      if (expanded) return new Text(raw, 0, 0);
      const oid = cm?.outputId ? ` · outputId: ${cm.outputId}` : "";
      const line = `${failed ? "✗" : "✓"} ${status}${dur}${oid} · ctrl+o to expand`;
      return new Text(theme.fg(failed ? "warning" : "success", line), 0, 0);
    },
  });

  pi.registerTool({
    name: "inspect",
    label: "Inspect Local Context",
    description: "Analyze a project-local text file or cached tool output without sending the raw content into context. Returns a local summary and snippets matching the query.",
    promptSnippet: "Summarize project files or cached output and retrieve snippets by query",
    promptGuidelines: [
      "Use inspect instead of read for large logs or text files, then refine with its query parameter.",
      "Use outputId when retrieving details from a previously summarized large tool output.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Project-local text file path" })),
      outputId: Type.Optional(Type.String({ description: "Local output cache id from a previous large tool result" })),
      query: Type.Optional(Type.String({ description: "Words that must appear in a matching line" })),
      maxSnippets: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      head: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    renderCall(args, theme, _context) {
      const arrow = theme.fg("toolTitle", "▶ ");
      const target = args.outputId ? `outputId ${args.outputId}` : args.path ?? "(no target)";
      const q = args.query ? ` · q:"${String(args.query).slice(0,40)}"` : "";
      return new Text(arrow + theme.fg("toolTitle", theme.bold("inspect")) + " " + theme.fg("dim", target + q), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) return renderToolLoading("inspect", 0, theme);
      const c0 = result.content[0]; const raw = c0?.type === "text" ? String(c0.text) : "";
      if (expanded) return new Text(raw, 0, 0);
      if ((result as any).isError) return new Text(theme.fg("error", "✗ inspect gagal · ctrl+o to expand"), 0, 0);
      const details = result.details as { path?: string; outputId?: string; query?: string; snippets?: number } | undefined;
      const target = details?.outputId ? `outputId ${details.outputId}` : details?.path ?? "hasil";
      const compactTarget = target.length > 48 ? `${target.slice(0, 47)}…` : target;
      const snippetInfo = details?.query
        ? ` · ${details.snippets ?? 0} snippet`
        : " · summary siap";
      return new Text(theme.fg("success", `✓ inspect · ${compactTarget}${snippetInfo} · ctrl+o to expand`), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (params.path && params.outputId) {
        throw new Error("Provide either path or outputId, not both.");
      }
      if (!params.path && !params.outputId) {
        throw new Error("Provide a project-local path or an outputId.");
      }

      let raw: string;
      let source: string;
      let bytes: number | undefined;
      let inspectOutputId: string | undefined = params.outputId;
      if (params.outputId) {
        raw = await outputCache.get(params.outputId) ?? "";
        if (!raw) throw new Error(`Output cache not found or expired: ${params.outputId}`);
        source = `dari cache ${params.outputId}`;
        bytes = Buffer.byteLength(raw, "utf8");
        recordRetrieval(stats);
      } else {
        const targetPath = resolve(ctx.cwd, params.path!.replace(/^@/, ""));
        const [realTarget, realCwd] = await Promise.all([
          realpath(targetPath).catch(() => targetPath),
          realpath(ctx.cwd).catch(() => ctx.cwd),
        ]);

        if (!isInsideProject(realCwd, realTarget)) {
          throw new Error("Only files inside the current project can be inspected.");
        }

        const metadata = await stat(realTarget);
        if (!metadata.isFile()) throw new Error("Path must reference a file.");
        if (metadata.size > MAX_INSPECT_FILE_BYTES) {
          throw new Error(`File is ${(metadata.size / 1024 / 1024).toFixed(1)} MB; the prototype limit is 10 MB.`);
        }
        try {
          raw = await readFile(realTarget, "utf8");
        } catch (cause) {
          throw new Error(`Gagal membaca file sebagai UTF-8: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        if (raw.includes("\uFFFD")) {
          // heuristik binary: jika mengandung replacement char, kemungkinan bukan text
          const sample = raw.slice(0, 1024);
          if (/\uFFFD/.test(sample) && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sample)) {
            throw new Error("File tampaknya binary, bukan text UTF-8.");
          }
        }
        source = `dari ${params.path}`;
        bytes = metadata.size;
        // File inspect juga mendapat cache nyata agar aman bila hasilnya dipangkas.
        inspectOutputId = await outputCache.save(raw);
      }

      stats.inspectCalls += 1;
      const summary = summarizeOutput(raw);
      const snippets = params.query
        ? findSnippets(raw, params.query, params.maxSnippets ?? 5, {
            before: params.before,
            after: params.after,
          })
        : [];
      const outputParts = [
        inspectOutputId
          ? `[context-manager] Raw source tersedia sebagai outputId "${inspectOutputId}".`
          : "",
        formatSummary(summary, source),
      ].filter(Boolean);
      if (params.query) {
        outputParts.push(
          snippets.length > 0
            ? `Snippet untuk "${params.query}":\n${snippets.map((item) => `---\n${item}`).join("\n")}`
            : `Tidak ada snippet yang cocok untuk "${params.query}".`,
        );
      }
      // dedup head/tail: jika overlap, gabung jadi satu range
      if (params.head && params.tail) {
        const totalLines = raw.split(/\r?\n/).length;
        if ((params.head + params.tail) >= totalLines) {
          outputParts.push(`Full (${totalLines} baris):\n${formatLineRange(raw, 1, totalLines)}`);
        } else {
          outputParts.push(`Head (${params.head} baris):\n${formatLineRange(raw, 1, params.head)}`);
          outputParts.push(`Tail (${params.tail} baris):\n${formatLineRange(raw, totalLines - params.tail + 1, totalLines)}`);
        }
      } else {
        if (params.head) outputParts.push(`Head (${params.head} baris):\n${formatLineRange(raw, 1, params.head)}`);
        if (params.tail) {
          const totalLines = raw.split(/\r?\n/).length;
          outputParts.push(`Tail (${params.tail} baris):\n${formatLineRange(raw, totalLines - params.tail + 1, totalLines)}`);
        }
      }
      const MAX_INSPECT_OUTPUT_CHARS = 20_000;
      let inspectText = outputParts.join("\n\n");
      if (inspectText.length > MAX_INSPECT_OUTPUT_CHARS) {
        inspectText = `${inspectText.slice(0, MAX_INSPECT_OUTPUT_CHARS)}\n[context-manager] Output inspect dipotong; persempit query/head/tail.`;
      }
      // Masuk budgeting context; outputId selalu real (baik cache maupun file path).
      if (inspectOutputId) outputCache.addActiveId(inspectOutputId);
      cachedToolResults.set(_toolCallId, { outputId: inspectOutputId ?? "", text: inspectText, priority: 0 });

      return {
        content: [{ type: "text", text: inspectText }],
        details: { path: params.path, outputId: inspectOutputId, query: params.query, bytes, summary, snippets: snippets.length },
      };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!LARGE_OUTPUT_TOOL_NAMES.has(event.toolName)) return;
    // ponytail: tetap proses isError agar output besar yang error juga bisa diambil via inspect; jangan drop berdasarkan isError.
    // Untuk menjaga kompatibilitas, tetap ringkas error besar tapi biarkan flag error asli tetap dipertahankan oleh caller.
    void event.isError;
    const raw = textFromContent(event.content);
    const lineCount = raw.split(/\r?\n/).length;
    const config = currentContextManagerConfig();
    const contextPercent = ctx.getContextUsage()?.percent;
    if (contextPercent !== null && contextPercent !== undefined && contextPercent > 80) recordHighContext(stats);
    const mode = selectCompressionMode(contextPercent);

    updateContextReminder(ctx, reminderState);

    if (raw.length < config.outputCharThreshold && lineCount < config.outputLineThreshold) return;

    const readInput = event as unknown as { input?: { path?: string; command?: string } };
    const source = event.toolName === "read" && readInput.input?.path
      ? `dari ${readInput.input.path}`
      : `dari tool ${event.toolName}`;

    if (mode === "preserve") {
      const outputId = await outputCache.save(raw);
      const command = readInput.input?.command ?? "";
      const text = raw;
      cachedToolResults.set(event.toolCallId, {
        outputId,
        text,
        priority: /\bgit\s+(?:status|diff)\b|\b(?:test|lint|typecheck|type-check|build)\b/i.test(command) ? 2 : 1,
      });
      recordSummary(stats, raw, text);
      return;
    }

    const outputId = await outputCache.save(raw);
    notify(ctx, `[Context Manager] output besar dari ${event.toolName} diringkas.`);
    // Kebijakan per jenis output: log→error+lokasi dominan, diff→hunk, kode→chunk. Fallback generic.
    const isDiff = /\bdiff\b|\b(git diff|show)\b|^diff --git/m.test(raw.slice(0, 4000)) || /\.diff\b/i.test(readInput.input?.path ?? "");
    const looksLog = /\b(error|failed|exception|traceback)\b/i.test(raw);
    const previewSize = isDiff ? 2 : looksLog ? 1 : 3;
    const cuplikanNote = "[cuplikan — bukan bacaan lengkap; gunakan inspect untuk bagian spesifik]";
    const headerPinned = `[context-manager] outputId: "${outputId}" | inspect: { outputId: "${outputId}", query: "<kata>" } ${cuplikanNote}`;
    let body = formatSummary(
      summarizeOutput(raw, previewSize),
      source,
      `Gunakan inspect dengan outputId "${outputId}" dan query untuk mengambil snippet yang relevan.`,
    );
    // pinned header: body boleh dipotong compaction (2000 char) tapi header tetap di atas
    if (mode === "compact") {
      body += `\n\n[context-manager] Context saat ini ${formatContextPercent(contextPercent)}. Jalankan /compact untuk menggunakan compaction bawaan Pi sebelum melanjutkan.`;
    }
    // potong body agar header+body muat ~1900 char (serializer Pi potong >=2000)
    const MAX_TOOL_RESULT_CHARS = 1900;
    const bodyMax = Math.max(200, MAX_TOOL_RESULT_CHARS - headerPinned.length - 2);
    const truncatedBody = body.length > bodyMax ? `${body.slice(0, bodyMax)}\n[context-manager] Ringkasan dipotong; gunakan outputId.` : body;
    let summarized = `${headerPinned}\n${truncatedBody}`;
    recordSummary(stats, raw, summarized);
    const command = readInput.input?.command ?? "";
    cachedToolResults.set(event.toolCallId, {
      outputId,
      text: summarized,
      priority: /\bgit\s+(?:status|diff)\b|\b(?:test|lint|typecheck|type-check|build)\b/i.test(command) ? 2 : 1,
    });
    // pertahankan details asli: merge contextManager tanpa menghilangkan field dari tool bawaan
    const prevDetails = (event as unknown as { details?: unknown }).details;
    const mergedDetails = prevDetails !== null && typeof prevDetails === "object" && !Array.isArray(prevDetails)
      ? { ...(prevDetails as Record<string, unknown>), contextManager: { outputId, originalChars: raw.length } }
      : prevDetails !== undefined
        ? { originalDetails: prevDetails, contextManager: { outputId, originalChars: raw.length } }
        : { contextManager: { outputId, originalChars: raw.length } };
    return {
      content: [{ type: "text", text: summarized }],
      details: mergedDetails,
    };
  });

  pi.on("context", (event, ctx) => {
    const cachedToolCallIds = [...new Set(
      [...event.messages]
        .reverse()
        .map((message) => (message as unknown as { toolCallId?: string }).toolCallId)
        .filter((toolCallId): toolCallId is string => Boolean(toolCallId && cachedToolResults.has(toolCallId))),
    )];
    const usage = ctx.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined && usage.percent > 80) recordHighContext(stats);
    const budgetPercent = currentContextManagerConfig().contextBudgetPercent;
    const budgetTokens = usage?.contextWindow
      ? Math.floor(usage.contextWindow * budgetPercent / 100)
      : 6_000; // ponytail: fallback 6000 bila contextWindow null (belum ada usage); ganti ke estimator berbasis pesan bila perlu presisi.
    const preservedToolCallIds = new Set<string>();
    let usedTokens = 0;
    let protectedCount = 0;

    for (const toolCallId of cachedToolCallIds) {
      if (prunedToolResults.has(toolCallId)) continue;
      const cached = cachedToolResults.get(toolCallId)!;
      const tokens = estimateTokens(cached.text);
      const mustKeep = preservedToolCallIds.size === 0
        || (cached.priority >= 2 && protectedCount < 5);
      if (mustKeep || usedTokens + tokens <= budgetTokens) {
        preservedToolCallIds.add(toolCallId);
        usedTokens += tokens;
        if (cached.priority >= 2) protectedCount += 1;
      }
    }

    let prunedInThisTurn = 0;
    const messages = event.messages.map((message) => {
      const candidate = message as unknown as {
        toolCallId?: string;
        content?: unknown;
      };
      const cached = candidate.toolCallId ? cachedToolResults.get(candidate.toolCallId) : undefined;
      if (!cached || (candidate.toolCallId && preservedToolCallIds.has(candidate.toolCallId))) return message;

      const replacement = `[context-manager] Output lama dikeluarkan dari context untuk menghemat token. Raw output tersedia sebagai outputId "${cached.outputId}"; gunakan inspect jika detail diperlukan.`;
      if (!prunedToolResults.has(candidate.toolCallId!)) {
        recordPrune(stats, textFromContent(candidate.content), replacement);
        prunedToolResults.add(candidate.toolCallId!);
        prunedInThisTurn += 1;
      }
      return {
        ...message,
        content: [{ type: "text", text: replacement }],
      } as typeof message;
    });
    if (prunedInThisTurn > 0) {
      lastPrunePrefixDirty = true;
      notify(ctx, `[Context Manager] ${prunedInThisTurn} output lama dipangkas dari context. Detail tetap tersedia via inspect.`, "warning");
    }

    updateContextReminder(ctx, reminderState);
    return { messages };
  });

  async function handleContextManagerStatus(_args: string, ctx: any) {
      const usage = ctx.getContextUsage();
      const liveUsage = usage?.percent === null || usage?.percent === undefined
        ? "Context saat ini: belum tersedia"
        : `Context saat ini: ${formatContextPercent(usage.percent)} (${usage.tokens?.toLocaleString("id-ID") ?? "?"}/${usage.contextWindow.toLocaleString("id-ID")} token)`;
      const config = currentContextManagerConfig();
      const budgetTokens = usage?.contextWindow ? Math.floor(usage.contextWindow * config.contextBudgetPercent / 100) : null;
      let badge = "";
      try {
        let keptTokens = 0; let protectedTokens = 0;
        for (const v of cachedToolResults.values()) { const t = estimateTokens(v.text); keptTokens += t; if (v.priority >= 2) protectedTokens += t; }
        if (budgetTokens !== null && keptTokens > budgetTokens) {
          badge = `\n⚠ Budget output tool ${config.contextBudgetPercent}% (~${budgetTokens.toLocaleString("id-ID")} token) terlampaui: kept ~${keptTokens.toLocaleString("id-ID")} token (protected ~${protectedTokens.toLocaleString("id-ID")}).`;
        }
        if (lastPrunePrefixDirty) badge += "\n↻ Prefix berubah setelah pruning. Teks lebih sedikit belum tentu lebih murah karena cache hit dapat berkurang.";
      } catch {}
      ctx.ui.notify(`${formatContextStats(stats)}\n${liveUsage}\n${formatConfig(config)}${badge}`, badge ? "warning" : "info");
      lastPrunePrefixDirty = false;
  }
  pi.registerCommand("context-manager", {
    description: "Show Context Manager session statistics",
    handler: async (_args, ctx) => handleContextManagerStatus(_args, ctx),
  });
  pi.registerCommand("context-manager-config", {
    description: "Configure Context Manager output thresholds and context budget",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/context-manager-config membutuhkan mode interaktif.", "error");
        return;
      }

      let config = currentContextManagerConfig();
      const menu = [
        "Threshold karakter",
        "Threshold baris",
        "Budget output tool",
        "Reset ke default",
        "Selesai",
      ];

      while (true) {
        const choice = await ctx.ui.select(
          "Context Manager Config",
          menu.map((item) => ["Threshold karakter", "Threshold baris", "Budget output tool"].includes(item)
            ? `${item} (${formatConfigValue(item, config)})`
            : item),
        );
        if (!choice || choice === "Selesai") return;

        if (choice.startsWith("Reset ke default")) {
          try {
            await resetContextManagerConfig();
            invalidateConfigCache();
            config = currentContextManagerConfig();
            ctx.ui.notify(`Konfigurasi di-reset. ${formatConfig(config)}`, "info");
          } catch (error) {
            ctx.ui.notify(`Gagal mereset konfigurasi: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          continue;
        }

        const isChars = choice.startsWith("Threshold karakter");
        const isLines = choice.startsWith("Threshold baris");
        const isBudget = choice.startsWith("Budget output tool") || choice.startsWith("Budget context");
        if (!isChars && !isLines && !isBudget) continue;

        const label = isChars ? "threshold karakter" : isLines ? "threshold baris" : "budget output tool (%)";
        const currentValue = isChars
          ? config.outputCharThreshold
          : isLines
            ? config.outputLineThreshold
            : config.contextBudgetPercent;
        const min = isChars ? MIN_OUTPUT_CHAR_THRESHOLD : isLines ? MIN_OUTPUT_LINE_THRESHOLD : MIN_CONTEXT_BUDGET_PERCENT;
        const max = isChars ? MAX_OUTPUT_CHAR_THRESHOLD : isLines ? MAX_OUTPUT_LINE_THRESHOLD : MAX_CONTEXT_BUDGET_PERCENT;
        const input = await ctx.ui.input(
          `Atur ${label}`,
          `Nilai saat ini ${currentValue.toLocaleString("id-ID")}; rentang ${min.toLocaleString("id-ID")}–${max.toLocaleString("id-ID")}`,
        );
        if (input === undefined) continue;

        const value = parseConfigInteger(input, min, max);
        if (value === undefined) {
          ctx.ui.notify(`Nilai harus bilangan bulat antara ${min.toLocaleString("id-ID")} dan ${max.toLocaleString("id-ID")}.`, "error");
          continue;
        }

        const nextConfig: ContextManagerConfig = {
          ...config,
          ...(isChars ? { outputCharThreshold: value } : {}),
          ...(isLines ? { outputLineThreshold: value } : {}),
          ...(isBudget ? { contextBudgetPercent: value } : {}),
        };
        try {
          await saveContextManagerConfig(nextConfig);
          invalidateConfigCache();
          config = nextConfig;
          ctx.ui.notify(`Konfigurasi tersimpan. ${formatConfig(config)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Gagal menyimpan konfigurasi: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    },
  });
}
