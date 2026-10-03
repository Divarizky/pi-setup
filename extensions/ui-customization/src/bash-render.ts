import { getLanguageFromPath, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  classifyLine,
  countIssues,
  formatBashDuration,
  lastNonEmptyLine,
  numberedTail,
  outputLines,
  parseBashResult,
  splitReadNotice,
} from "./bash-format.ts";
import { MAX_DIFF_ROWS } from "./diff-render.ts";
import { renderOutputRows, type OutputRow } from "./output-render.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./thinking-format.ts";
import {
  Block,
  controlSuffix,
  fitLine,
  fitWithSuffix,
  RESULT_INDENT,
  RESULT_PREFIX,
  resultText,
  type ToolRenderContext,
  type ToolResultLike,
} from "./tool-chrome.ts";
import { plural } from "./tool-format.ts";
import { canRequestRender, requestUiRender } from "./ui-binding.ts";

/** Output lines shown when a bash result is expanded. */
export const BASH_TAIL_LINES = 20;
const MAX_TRACKED_RUNS = 200;

type Run = { startedAt: number; durationMs?: number };
type BashDetails = {
  durationMs?: unknown;
  fullOutputPath?: unknown;
  truncation?: { truncated?: boolean; totalLines?: number };
};

const runs = new Map<string, Run>();
let animationTimer: ReturnType<typeof setInterval> | undefined;

function hasRunning(): boolean {
  for (const run of runs.values()) if (run.durationMs === undefined) return true;
  return false;
}

/** Keep repainting while a command runs, so the spinner and timer advance. */
function syncAnimation(): void {
  if (hasRunning() && canRequestRender()) {
    animationTimer ??= setInterval(requestUiRender, SPINNER_INTERVAL_MS);
    animationTimer.unref?.();
  } else if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = undefined;
  }
}

export function startTrackedRun(toolCallId: string): number {
  const startedAt = Date.now();
  runs.set(toolCallId, { startedAt });
  if (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value!);
  syncAnimation();
  return startedAt;
}

export function finishTrackedRun(toolCallId: string, durationMs: number): void {
  const run = runs.get(toolCallId);
  if (run) run.durationMs = durationMs;
  syncAnimation();
}

export function stopTrackedAnimation(): void {
  for (const run of runs.values()) run.durationMs ??= Date.now() - run.startedAt;
  syncAnimation();
}

function issueColor(line: string): ThemeColor {
  const issue = classifyLine(line);
  return issue === "error" ? "error" : issue === "warning" ? "warning" : "toolOutput";
}

/** Framed, numbered tail of the output; error and warning lines are marked. */
function tailRows(lines: string[], total: number, width: number, theme: Theme): string[] {
  const trimmed = lines.slice(0, lines.length - trailingBlankCount(lines));
  const tail = numberedTail(trimmed, total, BASH_TAIL_LINES);
  const rows: OutputRow[] = [];
  if (tail.hidden > 0) rows.push({ kind: "gap", label: plural(tail.hidden, "earlier line") });
  for (const row of tail.rows) rows.push({ kind: "line", ...row, tone: classifyLine(row.text) });
  return renderOutputRows(rows, width, theme);
}

function trailingBlankCount(lines: string[]): number {
  let count = 0;
  while (count < lines.length && lines[lines.length - 1 - count]!.trim() === "") count += 1;
  return count;
}

function totalLines(lines: string[], details: BashDetails): number {
  const total = details.truncation?.truncated ? details.truncation.totalLines : undefined;
  return typeof total === "number" && total > lines.length ? total : lines.length;
}

function runningBlock(
  result: ToolResultLike,
  expanded: boolean,
  theme: Theme,
  context: ToolRenderContext,
): Block {
  const lines = outputLines(resultText(result).replace(/\s+$/, ""));
  const details = (result.details ?? {}) as BashDetails;
  const total = totalLines(lines, details);
  const startedAt = runs.get(context.toolCallId)?.startedAt ?? Date.now();

  return new Block((width) => {
    const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
    const seconds = Math.floor((Date.now() - startedAt) / 1_000);
    const status = `running · ${seconds}s${total > 0 ? ` · ${plural(total, "line")}` : ""}`;
    const head = `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("accent", frame)} ${theme.fg("muted", status)}`;
    const control = total > 0 ? controlSuffix(theme, expanded) : "";
    const out = [fitWithSuffix(head, control, width, theme)];
    if (total === 0) return out;
    if (expanded) return [...out, ...tailRows(lines, total, width, theme)];
    const latest = lastNonEmptyLine(lines);
    if (latest) {
      out.push(fitLine(`${RESULT_INDENT}${theme.fg("dim", "└")} ${theme.fg(issueColor(latest), latest)}`, width, theme));
    }
    return out;
  }, true);
}

function finishedBlock(
  result: ToolResultLike,
  expanded: boolean,
  theme: Theme,
  context: ToolRenderContext,
): Block {
  const details = (result.details ?? {}) as BashDetails;
  const status = parseBashResult(resultText(result), context.isError);
  const lines = outputLines(status.output);
  const total = totalLines(lines, details);
  const issues = countIssues(lines);
  const duration =
    typeof details.durationMs === "number"
      ? details.durationMs
      : runs.get(context.toolCallId)?.durationMs;
  const fullOutput = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;

  const dot = theme.fg("dim", " · ");
  const badge =
    status.exitCode === 0
      ? theme.fg("success", "✓ exit 0")
      : theme.fg("error", status.exitCode !== undefined ? `✗ exit ${status.exitCode}` : `✗ ${status.failure}`);
  const parts = [badge];
  if (duration !== undefined) parts.push(theme.fg("muted", formatBashDuration(duration)));
  parts.push(theme.fg("muted", total === 0 ? "no output" : plural(total, "line")));
  const issueParts = [
    issues.errors > 0 ? theme.fg("error", plural(issues.errors, "error")) : "",
    issues.warnings > 0 ? theme.fg("warning", plural(issues.warnings, "warning")) : "",
  ].filter(Boolean);
  if (issueParts.length > 0) parts.push(issueParts.join(theme.fg("muted", ", ")));

  return new Block((width) => {
    // Collapsed view stays minimal: line count plus the expand hint. The
    // detailed status line (badge, duration, errors/warnings) appears only
    // when expanded.
    const summary = expanded
      ? fitWithSuffix(
          `${theme.fg("dim", RESULT_PREFIX)}${parts.join(dot)}`,
          lines.length > 0 ? controlSuffix(theme, expanded) : "",
          width,
          theme,
        )
      : fitWithSuffix(
          `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("muted", total === 0 ? "no output" : plural(total, "line"))}`,
          total > 0 ? controlSuffix(theme, expanded) : "",
          width,
          theme,
        );
    if (!expanded || lines.length === 0) return [summary];
    const out = [summary, ...tailRows(lines, total, width, theme)];
    if (fullOutput) {
      out.push(fitLine(`${RESULT_INDENT}${theme.fg("dim", `full output: ${fullOutput}`)}`, width, theme));
    }
    return out;
  });
}

/**
 * Read result with the same chrome as bash: spinner while reading, then a
 * `✓ Read · duration · N lines` line; expanded view tails the content.
 */
export function readResultBlock(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Block {
  if (options.isPartial) {
    return new Block((width) => {
      const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
      const startedAt = runs.get(context.toolCallId)?.startedAt ?? Date.now();
      const seconds = Math.floor((Date.now() - startedAt) / 1_000);
      return [
        fitWithSuffix(
          `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("accent", frame)} ${theme.fg("muted", `reading · ${seconds}s`)}`,
          "",
          width,
          theme,
        ),
      ];
    }, true);
  }

  const details = (result.details ?? {}) as BashDetails;
  const { content, notice } = splitReadNotice(resultText(result));
  const lines = outputLines(content);
  const total = totalLines(lines, details);
  const args = (context.args ?? {}) as { path?: unknown; offset?: unknown };
  const filePath = typeof args.path === "string" ? args.path.replace(/^@/, "") : undefined;
  const firstLine = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
  const duration =
    typeof details.durationMs === "number"
      ? details.durationMs
      : runs.get(context.toolCallId)?.durationMs;

  const dot = theme.fg("dim", " · ");
  const parts = [theme.fg("success", "✓ Read")];
  if (duration !== undefined) parts.push(theme.fg("muted", formatBashDuration(duration)));
  parts.push(theme.fg("muted", total === 0 ? "empty" : plural(total, "line")));
  if (details.truncation?.truncated) parts.push(theme.fg("warning", "truncated"));

  return new Block((width) => {
    const summary = options.expanded
      ? fitWithSuffix(
          `${theme.fg("dim", RESULT_PREFIX)}${parts.join(dot)}`,
          total > 0 ? controlSuffix(theme, options.expanded) : "",
          width,
          theme,
        )
      : fitWithSuffix(
          `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("muted", total === 0 ? "empty" : plural(total, "line"))}`,
          total > 0 ? controlSuffix(theme, options.expanded) : "",
          width,
          theme,
        );
    if (!options.expanded || lines.length === 0) return [summary];
    const shown = lines.slice(0, MAX_DIFF_ROWS);
    const rows: OutputRow[] = shown.map((text, index) => ({ kind: "line", no: firstLine + index, text }));
    if (lines.length > shown.length) {
      rows.push({ kind: "gap", label: plural(lines.length - shown.length, "more line") });
    }
    const language = filePath ? getLanguageFromPath(filePath) : undefined;
    const out = [summary, ...renderOutputRows(rows, width, theme, language)];
    if (notice) out.push(fitLine(`${RESULT_INDENT}${theme.fg("dim", notice)}`, width, theme));
    return out;
  });
}

/**
 * Bash result: spinner, timer and the newest line while running; exit code,
 * duration, line count and detected errors/warnings once finished.
 */
export function bashResultBlock(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Block {
  return options.isPartial
    ? runningBlock(result, options.expanded, theme, context)
    : finishedBlock(result, options.expanded, theme, context);
}
