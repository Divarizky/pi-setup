import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { bashResultBlock, finishTrackedRun, readResultBlock, startTrackedRun, stopTrackedAnimation } from "./bash-render.ts";
import { parseDisplayDiff } from "./diff-format.ts";
import { diffResultBlock } from "./diff-render.ts";
import {
  Block,
  controlSuffix,
  fitWithSuffix,
  RESULT_INDENT,
  RESULT_PREFIX,
  resultText,
  type ToolRenderContext,
  type ToolResultLike,
} from "./tool-chrome.ts";
import {
  callTitle,
  countLines,
  EXPANDED_MAX_LINES,
  previewLines,
  resultSummary,
} from "./tool-format.ts";
import {
  buildWritePreview,
  readPreviousFile,
  resolveWritePath,
  writeView,
} from "./write-preview.ts";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "ui-customization.json");

type StyledTool = "read" | "bash" | "edit" | "write";

/** Opt out with `{ "toolStyle": false }` in ~/.pi/agent/ui-customization.json. */
function toolStyleEnabled(): boolean {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      toolStyle?: unknown;
    };
    return config.toolStyle !== false;
  } catch {
    return true;
  }
}

function renderCallLine(
  toolName: StyledTool,
  args: Record<string, unknown>,
  theme: Theme,
  context: ToolRenderContext,
): Text {
  const pending = context.isPartial || !context.executionStarted;
  const bullet = pending
    ? theme.fg("muted", "●")
    : context.isError
      ? theme.fg("error", "●")
      : theme.fg("success", "●");
  const { label, arg } = callTitle(toolName, args, context.cwd, homedir());
  const argText = arg ? theme.fg("muted", `(${arg})`) : "";
  return new Text(
    `${bullet} ${theme.fg("toolTitle", theme.bold(label))}${argText}`,
    0,
    0,
  );
}

/** Summary line plus optional plain output, used by read, errors and fallbacks. */
function summaryBlock(
  toolName: StyledTool,
  result: ToolResultLike,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Block {
  if (options.isPartial) {
    return new Block(() => [theme.fg("dim", `${RESULT_PREFIX}Running…`)]);
  }

  const text = resultText(result);
  const details = (result.details ?? {}) as {
    truncation?: { truncated?: boolean; totalLines?: number };
  };
  const summary = resultSummary({
    toolName,
    text,
    isError: context.isError,
    hasImage: (result.content ?? []).some((part) => part?.type === "image"),
    truncatedFrom: details.truncation?.truncated ? details.truncation.totalLines : undefined,
  });

  // Errors expand to their full text only when the summary hides something.
  const body = context.isError
    ? countLines(text.trim()) > 1
      ? text.trim()
      : ""
    : toolName === "read"
      ? text
      : "";
  const preview = previewLines(body, EXPANDED_MAX_LINES);
  const summaryColor = context.isError ? "error" : "toolOutput";

  return new Block((width) => {
    const control = preview.lines.length > 0 ? controlSuffix(theme, options.expanded) : "";
    const head = fitWithSuffix(
      `${theme.fg("dim", RESULT_PREFIX)}${theme.fg(summaryColor, summary)}`,
      control,
      width,
      theme,
    );
    if (!options.expanded) return [head];
    const lines = [head];
    for (const line of preview.lines) {
      lines.push(`${RESULT_INDENT}${theme.fg("toolOutput", line)}`);
    }
    if (preview.hidden > 0) {
      lines.push(`${RESULT_INDENT}${theme.fg("muted", `… +${preview.hidden} lines`)}`);
    }
    // Text wraps long output lines to the width like Pi's own renderer.
    return new Text(lines.join("\n"), 0, 0).render(width);
  });
}

function renderResultBlock(
  toolName: StyledTool,
  result: ToolResultLike,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Block {
  if (toolName === "bash") return bashResultBlock(result, options, theme, context);
  if (toolName === "read") {
    const hasImage = (result.content ?? []).some((part) => part?.type === "image");
    if (options.isPartial || (!context.isError && !hasImage)) {
      return readResultBlock(result, options, theme, context);
    }
  }

  const args = (context.args ?? {}) as Record<string, unknown>;
  const filePath = typeof args.path === "string" ? args.path : undefined;
  if (!options.isPartial && !context.isError) {
    if (toolName === "edit") {
      const diff = (result.details as { diff?: unknown } | undefined)?.diff;
      if (typeof diff === "string" && diff.trim()) {
        return diffResultBlock(
          { kind: "diff", rows: parseDisplayDiff(diff) },
          options.expanded,
          theme,
          filePath,
        );
      }
    } else if (toolName === "write" && typeof args.content === "string") {
      return diffResultBlock(writeView(result.details, args.content), options.expanded, theme, filePath);
    }
  }
  return summaryBlock(toolName, result, options, theme, context);
}

type AnyDefinition = { execute: (...args: any[]) => Promise<any> };

/** Time read runs so the renderer can show a spinner and the duration. */
async function executeRead(
  definition: AnyDefinition,
  toolCallId: string,
  args: unknown[],
): Promise<any> {
  const startedAt = startTrackedRun(toolCallId);
  try {
    const result = await definition.execute(toolCallId, ...args);
    const durationMs = Date.now() - startedAt;
    finishTrackedRun(toolCallId, durationMs);
    return { ...result, details: { ...(result?.details ?? {}), durationMs } };
  } catch (error) {
    finishTrackedRun(toolCallId, Date.now() - startedAt);
    throw error;
  }
}

/** Time bash runs so the renderer can show a spinner and the duration. */
async function executeBash(
  definition: AnyDefinition,
  toolCallId: string,
  args: unknown[],
): Promise<any> {
  const startedAt = startTrackedRun(toolCallId);
  try {
    const result = await definition.execute(toolCallId, ...args);
    const durationMs = Date.now() - startedAt;
    finishTrackedRun(toolCallId, durationMs);
    return { ...result, details: { ...(result?.details ?? {}), durationMs } };
  } catch (error) {
    finishTrackedRun(toolCallId, Date.now() - startedAt);
    throw error;
  }
}

/**
 * Capture the file a write replaces, then store a compact diff in the result.
 * The previous content is read before Pi's own write queue, so two parallel
 * writes to the same file may compare against a stale version.
 */
async function executeWrite(
  definition: AnyDefinition,
  toolCallId: string,
  params: { path?: unknown; content?: unknown },
  rest: unknown[],
  cwd: string,
): Promise<any> {
  const previous =
    typeof params?.path === "string"
      ? await readPreviousFile(resolveWritePath(params.path, cwd))
      : undefined;
  const result = await definition.execute(toolCallId, params, ...rest);
  if (!previous || result?.isError || typeof params.content !== "string") return result;
  return {
    ...result,
    details: {
      ...(result.details ?? {}),
      writePreview: buildWritePreview(previous, params.content),
    },
  };
}

/**
 * Claude Code-style rendering for the default built-in tools:
 * `● read(src/index.ts)` then `⎿  Read 120 lines`.
 * Execution is delegated to Pi's own tool definitions.
 */
export function installToolRendering(pi: ExtensionAPI): void {
  if (!toolStyleEnabled()) return;

  const factories = {
    read: createReadToolDefinition,
    bash: createBashToolDefinition,
    edit: createEditToolDefinition,
    write: createWriteToolDefinition,
  } as const;

  for (const toolName of Object.keys(factories) as StyledTool[]) {
    const create = factories[toolName] as (cwd: string) => any;
    const byCwd = new Map<string, any>();
    const definitionFor = (cwd: string) => {
      let definition = byCwd.get(cwd);
      if (!definition) {
        definition = create(cwd);
        byCwd.set(cwd, definition);
      }
      return definition;
    };
    const base = definitionFor(process.cwd());

    pi.registerTool({
      ...base,
      renderShell: "self",
      execute(toolCallId, params, signal, onUpdate, ctx) {
        const definition = definitionFor(ctx.cwd);
        if (toolName === "bash") {
          return executeBash(definition, toolCallId, [params, signal, onUpdate, ctx]);
        }
        if (toolName === "read") {
          return executeRead(definition, toolCallId, [params, signal, onUpdate, ctx]);
        }
        if (toolName === "write") {
          return executeWrite(
            definition,
            toolCallId,
            params as { path?: unknown; content?: unknown },
            [signal, onUpdate, ctx],
            ctx.cwd,
          );
        }
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme, context) {
        return renderCallLine(
          toolName,
          (args ?? {}) as Record<string, unknown>,
          theme,
          context,
        );
      },
      renderResult(result, options, theme, context) {
        return renderResultBlock(toolName, result, options, theme, context);
      },
    });
  }

  pi.on("session_shutdown", async () => stopTrackedAnimation());
}
