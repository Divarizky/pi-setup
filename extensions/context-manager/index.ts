import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  findSnippets,
  formatSummary,
  summarizeOutput,
} from "./src/context-summary.ts";
import {
  createContextStats,
  formatContextStats,
  recordPrune,
  recordRetrieval,
  recordSummary,
} from "./src/context-stats.ts";
import { OutputCache } from "./src/output-cache.ts";
import {
  formatContextPercent,
  selectCompressionMode,
} from "./src/context-policy.ts";

const LARGE_OUTPUT_CHARS = 15_000;
const LARGE_OUTPUT_LINES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

export default function (pi: ExtensionAPI) {
  let stats = createContextStats();
  const outputCache = new OutputCache();
  const cachedToolResults = new Map<
    string,
    { outputId: string; text: string }
  >();
  const prunedToolResults = new Set<string>();

  pi.on("session_start", () => {
    stats = createContextStats();
    void outputCache.cleanup();
    cachedToolResults.clear();
    prunedToolResults.clear();
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
        const path = resolve(ctx.cwd, params.path!.replace(/^@/, ""));
        if (!isInsideProject(ctx.cwd, path)) {
          throw new Error(
            "Only files inside the current project can be inspected.",
          );
        }

        const metadata = await stat(path);
        if (!metadata.isFile()) throw new Error("Path must reference a file.");
        if (metadata.size > MAX_FILE_BYTES) {
          throw new Error(
            `File is ${(metadata.size / 1024 / 1024).toFixed(1)} MB; the prototype limit is 10 MB.`,
          );
        }
        raw = await readFile(path, "utf8");
        source = `dari ${params.path}`;
        bytes = metadata.size;
      }

      stats.inspectCalls += 1;
      const summary = summarizeOutput(raw);
      const snippets = params.query
        ? findSnippets(raw, params.query, params.maxSnippets ?? 5)
        : [];
      const output = [formatSummary(summary, source)];
      if (params.query) {
        output.push(
          snippets.length > 0
            ? `Snippet untuk "${params.query}":\n${snippets.map((item) => `---\n${item}`).join("\n")}`
            : `Tidak ada snippet yang cocok untuk "${params.query}".`,
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

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("read", event)) return;
    const requestedLimit = event.input.limit;
    if (requestedLimit === undefined || requestedLimit > 400) {
      ctx.ui.setStatus(
        "context-manager",
        "File besar terdeteksi — gunakan ctx_inspect",
      );
    }
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

    if (mode === "compact") {
      ctx.ui.setStatus(
        "context-manager",
        `Context tinggi (${formatContextPercent(contextPercent)}) — jalankan /compact`,
      );
    }

    if (raw.length < LARGE_OUTPUT_CHARS && lineCount < LARGE_OUTPUT_LINES)
      return;

    const readInput = event as unknown as { input?: { path?: string } };
    const source =
      event.toolName === "read" && readInput.input?.path
        ? `dari ${readInput.input.path}`
        : `dari tool ${event.toolName}`;

    if (mode === "preserve") {
      ctx.ui.setStatus(
        "context-manager",
        "Output besar dipertahankan — context di bawah 30%",
      );
      return;
    }

    ctx.ui.setStatus(
      "context-manager",
      mode === "compact"
        ? "Output besar diringkas agresif"
        : "Output besar diringkas otomatis",
    );
    const outputId = await outputCache.save(raw);
    let summarized = formatSummary(
      summarizeOutput(raw, mode === "compact" ? 1 : 3),
      source,
      `Gunakan ctx_inspect dengan outputId "${outputId}" dan query untuk mengambil snippet yang relevan.`,
    );
    if (mode === "compact") {
      summarized += `\n\n[context-manager] Context saat ini ${formatContextPercent(contextPercent)}. Jalankan /compact untuk menggunakan compaction bawaan Pi sebelum melanjutkan.`;
    }
    recordSummary(stats, raw, summarized);
    cachedToolResults.set(event.toolCallId, { outputId, text: summarized });
    return {
      content: [{ type: "text", text: summarized }],
      details: { contextManager: { outputId, originalChars: raw.length } },
    };
  });

  pi.on("context", (event) => {
    const latestCachedToolCallId = [...event.messages]
      .reverse()
      .map(
        (message) => (message as unknown as { toolCallId?: string }).toolCallId,
      )
      .find((toolCallId) => toolCallId && cachedToolResults.has(toolCallId));

    const messages = event.messages.map((message) => {
      const candidate = message as unknown as {
        toolCallId?: string;
        content?: unknown;
      };
      const cached = candidate.toolCallId
        ? cachedToolResults.get(candidate.toolCallId)
        : undefined;
      if (!cached || candidate.toolCallId === latestCachedToolCallId)
        return message;

      const replacement = `[context-manager] Output lama dikeluarkan dari context untuk menghemat token. Raw output tersedia sebagai outputId "${cached.outputId}"; gunakan ctx_inspect jika detail diperlukan.`;
      if (!prunedToolResults.has(candidate.toolCallId!)) {
        recordPrune(stats, textFromContent(candidate.content), replacement);
        prunedToolResults.add(candidate.toolCallId!);
      }
      return {
        ...message,
        content: [{ type: "text", text: replacement }],
      } as typeof message;
    });

    return { messages };
  });

  pi.registerCommand("context-manager-status", {
    description: "Show Context Manager session statistics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatContextStats(stats), "info");
    },
  });

  pi.registerCommand("context-manager-info", {
    description: "Show Context Manager prototype thresholds",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Context Manager aktif: output >= ${LARGE_OUTPUT_CHARS.toLocaleString("id-ID")} karakter atau ${LARGE_OUTPUT_LINES} baris diproses. <30% context dipertahankan; 30–60% mulai dihemat; >60% disarankan /compact. Gunakan ctx_inspect untuk file lokal.`,
        "info",
      );
    },
  });
}
