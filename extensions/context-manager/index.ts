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
  recordSummary,
} from "./src/context-stats.ts";

const LARGE_OUTPUT_CHARS = 12_000;
const LARGE_OUTPUT_LINES = 400;
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

  pi.on("session_start", () => {
    stats = createContextStats();
  });

  pi.registerTool({
    name: "ctx_inspect",
    label: "Inspect Local Context",
    description:
      "Analyze a project-local text file without sending the raw file into context. Returns a local summary and snippets matching the query.",
    promptSnippet:
      "Summarize large project-local files and retrieve snippets by query",
    promptGuidelines: [
      "Use ctx_inspect instead of read for large logs or text files, then refine with its query parameter.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Project-local text file path" }),
      query: Type.Optional(
        Type.String({
          description: "Words that must appear in a matching line",
        }),
      ),
      maxSnippets: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const path = resolve(ctx.cwd, params.path.replace(/^@/, ""));
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

      const raw = await readFile(path, "utf8");
      stats.inspectCalls += 1;
      const summary = summarizeOutput(raw);
      const snippets = params.query
        ? findSnippets(raw, params.query, params.maxSnippets ?? 5)
        : [];
      const output = [formatSummary(summary, `dari ${params.path}`)];
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
          path,
          bytes: metadata.size,
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
        "large file read: prefer ctx_inspect",
      );
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (
      event.isError ||
      !["read", "bash", "powershell", "grep"].includes(event.toolName)
    )
      return;
    const raw = textFromContent(event.content);
    const lineCount = raw.split(/\r?\n/).length;
    if (raw.length < LARGE_OUTPUT_CHARS && lineCount < LARGE_OUTPUT_LINES)
      return;

    const readInput = event as unknown as { input?: { path?: string } };
    const source =
      event.toolName === "read" && readInput.input?.path
        ? `dari ${readInput.input.path}`
        : `dari tool ${event.toolName}`;
    ctx.ui.setStatus("context-manager", "large output summarized locally");
    const summarized = formatSummary(summarizeOutput(raw), source);
    recordSummary(stats, raw, summarized);
    return { content: [{ type: "text", text: summarized }] };
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
        `Context Manager aktif: output >= ${LARGE_OUTPUT_CHARS.toLocaleString("id-ID")} karakter atau ${LARGE_OUTPUT_LINES} baris diringkas. Gunakan ctx_inspect untuk file lokal.`,
        "info",
      );
    },
  });
}
