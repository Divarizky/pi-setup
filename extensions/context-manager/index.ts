import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
  recordRetrieval,
  estimateTokens,
  recordSummary,
} from "./src/context-stats.ts";
import { OutputCache } from "./src/output-cache.ts";
import {
  formatContextPercent,
  selectCompressionMode,
} from "./src/context-policy.ts";
import {
  isPotentiallyMutating,
  runScript,
  type RunnerRuntime,
} from "./src/command-runner.ts";

const LARGE_OUTPUT_CHARS = 15_000;
const LARGE_OUTPUT_LINES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTION_OUTPUT_CHARS = 5_000;
const MAX_EXECUTION_TIMEOUT_MS = 300_000;
const MAX_EXECUTION_OUTPUT_CHARS = 100_000;
const DEFAULT_CONTEXT_BUDGET_PERCENT = 20;
const MIN_CONTEXT_BUDGET_PERCENT = 15;
const MAX_CONTEXT_BUDGET_PERCENT = 30;

function contextBudgetPercent(): number {
  const configured = Number.parseInt(
    process.env.PI_CONTEXT_MANAGER_BUDGET_PERCENT ?? "",
    10,
  );
  if (!Number.isFinite(configured)) return DEFAULT_CONTEXT_BUDGET_PERCENT;
  return Math.max(
    MIN_CONTEXT_BUDGET_PERCENT,
    Math.min(configured, MAX_CONTEXT_BUDGET_PERCENT),
  );
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || !("type" in part))
        return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("\n");
}

function isInsideProject(cwd: string, path: string): boolean {
  const relativePath = relative(cwd, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")
  );
}

type ReminderLevel = "below" | "moderate" | "compact" | "unknown";
interface ReminderState {
  level: ReminderLevel;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function contextReminderLevel(
  percent: number | null | undefined,
): ReminderLevel {
  if (percent === null || percent === undefined) return "unknown";
  if (percent <= 30) return "below";
  if (percent <= 60) return "moderate";
  return "compact";
}

function updateContextReminder(ctx: ExtensionContext, state: ReminderState) {
  const percent = ctx.getContextUsage()?.percent;
  const level = contextReminderLevel(percent);
  if (level === state.level && level !== "unknown") return;
  state.level = level;

  if (level === "below" || level === "unknown") return;

  notify(
    ctx,
    `[Context Manager] penggunaan context ${formatContextPercent(percent)}%. Output berikutnya akan diringkas`,
    "warning",
  );
}

export default function (pi: ExtensionAPI) {
  let stats = createContextStats();
  const reminderState = { level: "unknown" as ReminderLevel };
  const outputCache = new OutputCache();
  const cachedToolResults = new Map<
    string,
    { outputId: string; text: string; priority: number }
  >();
  const prunedToolResults = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    stats = createContextStats();
    outputCache.resetSession();
    void outputCache.cleanup();
    cachedToolResults.clear();
    prunedToolResults.clear();
    reminderState.level = "unknown";
    updateContextReminder(ctx, reminderState);
  });

  pi.on("turn_end", (_event, ctx) => updateContextReminder(ctx, reminderState));

  pi.registerTool({
    name: "ctx_execute",
    label: "Execute Context-Safe Script",
    description:
      "Run a general non-interactive shell or script in the project and return a compact result. Raw output is cached for later inspection. Read-only is the default; potentially mutating commands require explicit user confirmation.",
    promptSnippet:
      "Run a project-local script and return only a compact, cached result",
    promptGuidelines: [
      "Prefer ctx_execute for tests, lint, builds, git inspection, and processing large outputs.",
      "Use runtime shell, javascript, typescript, or python; keep the script non-interactive.",
      "Potentially mutating commands require user confirmation and should not be used for routine inspection.",
    ],
    parameters: Type.Object({
      runtime: Type.Optional(
        Type.Union([
          Type.Literal("shell"),
          Type.Literal("javascript"),
          Type.Literal("typescript"),
          Type.Literal("python"),
        ]),
      ),
      script: Type.String({
        description: "Shell command or script to execute",
      }),
      cwd: Type.Optional(
        Type.String({ description: "Project-local working directory" }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: MAX_EXECUTION_TIMEOUT_MS }),
      ),
      maxOutputChars: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: MAX_EXECUTION_OUTPUT_CHARS }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const runtime = (params.runtime ?? "shell") as RunnerRuntime;
      const requestedCwd = resolve(ctx.cwd, params.cwd ?? ".");
      const [realRequestedCwd, realProjectCwd] = await Promise.all([
        realpath(requestedCwd).catch(() => requestedCwd),
        realpath(ctx.cwd).catch(() => ctx.cwd),
      ]);
      if (!isInsideProject(realProjectCwd, realRequestedCwd)) {
        throw new Error(
          "ctx_execute hanya boleh bekerja di dalam current project.",
        );
      }

      if (isPotentiallyMutating(runtime, params.script)) {
        if (!ctx.hasUI) {
          throw new Error(
            "Command berpotensi mengubah data dan membutuhkan konfirmasi user dalam mode interaktif.",
          );
        }
        const approved = await ctx.ui.confirm(
          "Konfirmasi ctx_execute",
          `Script berpotensi mengubah data:\n\n${params.script.slice(0, 2_000)}\n\nJalankan sekarang?`,
        );
        if (!approved) throw new Error("Eksekusi dibatalkan oleh user.");
      }

      const result = await runScript({
        runtime,
        script: params.script,
        cwd: realRequestedCwd,
        timeoutMs: params.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        maxRawOutputChars: MAX_FILE_BYTES,
        signal,
      });
      const raw = result.output || "[no output]";
      const outputId = await outputCache.save(raw);
      if (
        raw.length >= LARGE_OUTPUT_CHARS ||
        raw.split(/\r?\n/).length >= LARGE_OUTPUT_LINES
      ) {
        notify(
          ctx,
          "[Context Manager] output besar dari ctx_execute diringkas.",
        );
      }
      const status = result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "success"
          : `failed (exit ${result.exitCode ?? "unknown"})`;
      const summary = formatSummary(
        summarizeOutput(raw, 2),
        `dari ctx_execute (${runtime})`,
        `Gunakan ctx_inspect dengan outputId "${outputId}" dan query untuk mengambil raw output yang relevan.`,
      );
      const output = [
        `[context-manager] Status: ${status}; durasi: ${result.durationMs} ms.`,
        summary,
        `Output cache: ${outputId}`,
      ].join("\n");
      const maxOutputChars = Math.max(
        1_000,
        Math.min(
          params.maxOutputChars ?? DEFAULT_EXECUTION_OUTPUT_CHARS,
          MAX_EXECUTION_OUTPUT_CHARS,
        ),
      );
      const boundedOutput =
        output.length > maxOutputChars
          ? `${output.slice(0, maxOutputChars - 80)}\n[context-manager] Summary dipotong; gunakan outputId untuk detail.`
          : output;
      recordSummary(stats, raw, boundedOutput);
      cachedToolResults.set(toolCallId, {
        outputId,
        text: boundedOutput,
        priority: result.exitCode === 0 && !result.timedOut ? 1 : 2,
      });
      return {
        content: [{ type: "text", text: boundedOutput }],
        details: {
          contextManager: {
            outputId,
            runtime,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          },
        },
        isError: result.exitCode !== 0 || result.timedOut,
      };
    },
  });

  pi.registerTool({
    name: "ctx_inspect",
    label: "Inspect Local Context",
    description:
      "Analyze a project-local text file or cached tool output without sending the raw content into context. Returns a local summary and snippets matching the query.",
    promptSnippet:
      "Summarize project files or cached output and retrieve snippets by query",
    promptGuidelines: [
      "Use ctx_inspect instead of read for large logs or text files, then refine with its query parameter.",
      "Use outputId when retrieving details from a previously summarized large tool output.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Project-local text file path" }),
      ),
      outputId: Type.Optional(
        Type.String({
          description:
            "Local output cache id from a previous large tool result",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Words that must appear in a matching line",
        }),
      ),
      maxSnippets: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      head: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
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
      if (params.outputId) {
        raw = (await outputCache.get(params.outputId)) ?? "";
        if (!raw)
          throw new Error(
            `Output cache not found or expired: ${params.outputId}`,
          );
        source = `dari output ${params.outputId}`;
        bytes = Buffer.byteLength(raw, "utf8");
        recordRetrieval(stats);
      } else {
        const targetPath = resolve(ctx.cwd, params.path!.replace(/^@/, ""));
        const [realTarget, realCwd] = await Promise.all([
          realpath(targetPath).catch(() => targetPath),
          realpath(ctx.cwd).catch(() => ctx.cwd),
        ]);

        if (!isInsideProject(realCwd, realTarget)) {
          throw new Error(
            "Only files inside the current project can be inspected.",
          );
        }

        const metadata = await stat(realTarget);
        if (!metadata.isFile()) throw new Error("Path must reference a file.");
        if (metadata.size > MAX_FILE_BYTES) {
          throw new Error(
            `File is ${(metadata.size / 1024 / 1024).toFixed(1)} MB; the prototype limit is 10 MB.`,
          );
        }
        raw = await readFile(realTarget, "utf8");
        source = `dari ${params.path}`;
        bytes = metadata.size;
      }

      stats.inspectCalls += 1;
      const summary = summarizeOutput(raw);
      const snippets = params.query
        ? findSnippets(raw, params.query, params.maxSnippets ?? 5, {
            before: params.before,
            after: params.after,
          })
        : [];
      const output = [formatSummary(summary, source)];
      if (params.query) {
        output.push(
          snippets.length > 0
            ? `Snippet untuk "${params.query}":\n${snippets.map((item) => `---\n${item}`).join("\n")}`
            : `Tidak ada snippet yang cocok untuk "${params.query}".`,
        );
      }
      if (params.head)
        output.push(
          `Head (${params.head} baris):\n${formatLineRange(raw, 1, params.head)}`,
        );
      if (params.tail) {
        const totalLines = raw.split(/\r?\n/).length;
        output.push(
          `Tail (${params.tail} baris):\n${formatLineRange(raw, totalLines - params.tail + 1, totalLines)}`,
        );
      }

      return {
        content: [{ type: "text", text: output.join("\n\n") }],
        details: {
          path: params.path,
          outputId: params.outputId,
          bytes,
          summary,
          snippets: snippets.length,
        },
      };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      event.isError ||
      !["read", "bash", "powershell", "grep"].includes(event.toolName)
    )
      return;
    const raw = textFromContent(event.content);
    const lineCount = raw.split(/\r?\n/).length;
    const contextPercent = ctx.getContextUsage()?.percent;
    const mode = selectCompressionMode(contextPercent);

    updateContextReminder(ctx, reminderState);

    if (raw.length < LARGE_OUTPUT_CHARS && lineCount < LARGE_OUTPUT_LINES)
      return;

    const readInput = event as unknown as {
      input?: { path?: string; command?: string };
    };
    const source =
      event.toolName === "read" && readInput.input?.path
        ? `dari ${readInput.input.path}`
        : `dari tool ${event.toolName}`;

    if (mode === "preserve") {
      const outputId = await outputCache.save(raw);
      const command = readInput.input?.command ?? "";
      cachedToolResults.set(event.toolCallId, {
        outputId,
        text: raw,
        priority:
          /\bgit\s+(?:status|diff)\b|\b(?:test|lint|typecheck|type-check|build)\b/i.test(
            command,
          )
            ? 2
            : 1,
      });
      return;
    }

    const outputId = await outputCache.save(raw);
    notify(
      ctx,
      `[Context Manager] output besar dari ${event.toolName} diringkas.`,
    );
    let summarized = formatSummary(
      summarizeOutput(raw, mode === "compact" ? 1 : 3),
      source,
      `Gunakan ctx_inspect dengan outputId "${outputId}" dan query untuk mengambil snippet yang relevan.`,
    );
    if (mode === "compact") {
      summarized += `\n\n[context-manager] Context saat ini ${formatContextPercent(contextPercent)}. Jalankan /compact untuk menggunakan compaction bawaan Pi sebelum melanjutkan.`;
    }
    recordSummary(stats, raw, summarized);
    const command = readInput.input?.command ?? "";
    cachedToolResults.set(event.toolCallId, {
      outputId,
      text: summarized,
      priority:
        /\bgit\s+(?:status|diff)\b|\b(?:test|lint|typecheck|type-check|build)\b/i.test(
          command,
        )
          ? 2
          : 1,
    });
    return {
      content: [{ type: "text", text: summarized }],
      details: { contextManager: { outputId, originalChars: raw.length } },
    };
  });

  pi.on("context", (event, ctx) => {
    const cachedToolCallIds = [...event.messages]
      .reverse()
      .map(
        (message) => (message as unknown as { toolCallId?: string }).toolCallId,
      )
      .filter((toolCallId): toolCallId is string =>
        Boolean(toolCallId && cachedToolResults.has(toolCallId)),
      );
    const usage = ctx.getContextUsage();
    const budgetPercent = contextBudgetPercent();
    const budgetTokens = usage?.contextWindow
      ? Math.floor((usage.contextWindow * budgetPercent) / 100)
      : 6_000;
    const preservedToolCallIds = new Set<string>();
    let usedTokens = 0;
    let protectedCount = 0;

    for (const toolCallId of cachedToolCallIds) {
      if (prunedToolResults.has(toolCallId)) continue;
      const cached = cachedToolResults.get(toolCallId)!;
      const tokens = estimateTokens(cached.text);
      const mustKeep =
        preservedToolCallIds.size === 0 ||
        (cached.priority >= 2 && protectedCount < 5);
      if (mustKeep || usedTokens + tokens <= budgetTokens) {
        preservedToolCallIds.add(toolCallId);
        usedTokens += tokens;
        if (cached.priority >= 2) protectedCount += 1;
      }
    }

    const messages = event.messages.map((message) => {
      const candidate = message as unknown as {
        toolCallId?: string;
        content?: unknown;
      };
      const cached = candidate.toolCallId
        ? cachedToolResults.get(candidate.toolCallId)
        : undefined;
      if (
        !cached ||
        (candidate.toolCallId && preservedToolCallIds.has(candidate.toolCallId))
      )
        return message;

      const replacement = `[context-manager] Output lama dikeluarkan dari context untuk menghemat token. Raw output tersedia sebagai outputId "${cached.outputId}"; gunakan ctx_inspect jika detail diperlukan.`;
      if (!prunedToolResults.has(candidate.toolCallId!)) {
        recordPrune(stats, textFromContent(candidate.content), replacement);
        prunedToolResults.add(candidate.toolCallId!);
        notify(
          ctx,
          "[Context Manager] output lama dipangkas dari context. Raw output tetap tersedia untuk retrieval.",
          "warning",
        );
      }
      return {
        ...message,
        content: [{ type: "text", text: replacement }],
      } as typeof message;
    });

    updateContextReminder(ctx, reminderState);
    return { messages };
  });

  pi.registerCommand("context-manager-status", {
    description: "Show Context Manager session statistics",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const liveUsage =
        usage?.percent === null || usage?.percent === undefined
          ? "Context saat ini: belum tersedia"
          : `Context saat ini: ${formatContextPercent(usage.percent)} (${usage.tokens?.toLocaleString("id-ID") ?? "?"}/${usage.contextWindow.toLocaleString("id-ID")} token)`;
      ctx.ui.notify(`${formatContextStats(stats)}\n${liveUsage}`, "info");
    },
  });

  pi.registerCommand("context-manager-info", {
    description: "Show Context Manager prototype thresholds",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Context Manager aktif: output >= ${LARGE_OUTPUT_CHARS.toLocaleString("id-ID")} karakter atau ${LARGE_OUTPUT_LINES} baris diproses. Budget output lama ${contextBudgetPercent()}% context window; <30% context dipertahankan; 30–60% mulai dihemat; >60% disarankan /compact. Gunakan ctx_inspect untuk file lokal.`,
        "info",
      );
    },
  });
}
