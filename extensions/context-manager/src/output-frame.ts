import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OutputPreview } from "./output-preview.ts";

/** Framed output rows, matching the edit/write diff layout of ui-customization. */
export type FrameRow =
  | { kind: "line"; no: number; text: string; tone?: "error" | "warning" | "hit" }
  | { kind: "gap"; label: string };

/** Output lines outside the frame, such as section headers. */
export type FrameBlock = { kind: "text"; text: string } | { kind: "rows"; rows: FrameRow[] };

type FrameTheme = {
  fg(color: string, text: string): string;
  getBgAnsi?(color: string): string;
};

const INDENT = "     ";
const BG_RESET = "\x1b[49m";
const ZERO_COUNT =
  /\b(?:0|no|zero)\s+(?:errors?|warnings?|failures?|failed|problems?)\b|\b(?:errors?|warnings?|failures?|failed|fail)\s*[:=]?\s*0\b/i;
const ERROR_LINE =
  /\b(?:errors?|failed|failures?|fatal|exception|panic)\b|\bfail\b|ERR!|✖|✗|❌|\bE\d{3,}\b/i;
const WARNING_LINE = /\b(?:warn|warnings?|deprecated)\b|⚠/i;
const NUMBERED_LINE = /^(\d+): ?(.*)$/;

/** Keyword-based guess; counts like `0 errors` are not issues. */
export function classifyLine(line: string): "error" | "warning" | undefined {
  if (!line.trim() || ZERO_COUNT.test(line)) return undefined;
  if (ERROR_LINE.test(line)) return "error";
  if (WARNING_LINE.test(line)) return "warning";
  return undefined;
}

/**
 * Head and tail of an execute preview, numbered by position in the full
 * output, with the skipped middle as one gap row.
 */
export function previewRows(preview: OutputPreview, maxLines: number): FrameRow[] {
  const total = Math.max(0, Math.floor(preview.totalLines) || 0);
  if (total === 0) return [];
  const line = (no: number, text: string): FrameRow => ({ kind: "line", no, text, tone: classifyLine(text) });
  const known = [...preview.head, ...preview.tail];
  if (total <= maxLines && known.length >= total) {
    return known.slice(0, total).map((text, index) => line(index + 1, text));
  }
  const head = preview.head.slice(0, Math.ceil(maxLines / 2));
  const tail = preview.tail.slice(-(maxLines - head.length));
  const omitted = Math.max(0, total - head.length - tail.length);
  return [
    ...head.map((text, index) => line(index + 1, text)),
    ...(omitted > 0 ? [{ kind: "gap" as const, label: `+${omitted} lines omitted` }] : []),
    ...tail.map((text, index) => line(total - tail.length + index + 1, text)),
  ];
}

/**
 * Split inspect output into plain text and numbered `N: text` runs.
 * `---` between snippets becomes a gap; lines matching every query term are hits.
 */
export function inspectBlocks(raw: string, query?: string): FrameBlock[] {
  const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const blocks: FrameBlock[] = [];
  let rows: FrameRow[] | undefined;
  let pendingGap = false;
  for (const text of raw.split(/\r?\n/)) {
    const match = NUMBERED_LINE.exec(text);
    if (match) {
      const body = match[2] ?? "";
      const hit = terms.length > 0 && terms.every((term) => body.toLowerCase().includes(term));
      if (!rows) {
        rows = [];
        blocks.push({ kind: "rows", rows });
      } else if (pendingGap) {
        rows.push({ kind: "gap", label: "" });
      }
      pendingGap = false;
      rows.push({ kind: "line", no: Number(match[1]), text: body, tone: hit ? "hit" : classifyLine(body) });
      continue;
    }
    if (text.trim() === "---") {
      pendingGap = true;
      continue;
    }
    rows = undefined;
    pendingGap = false;
    if (text.trim() !== "") blocks.push({ kind: "text", text });
  }
  return blocks;
}

/**
 * Cut plain text to `max` columns with a trailing "…". Unlike truncateToWidth
 * it adds no reset codes, so a tinted row keeps its background.
 */
function cutText(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = visibleWidth(char);
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

function errorBg(theme: FrameTheme): string {
  try {
    return theme.getBgAnsi?.("toolErrorBg") ?? "";
  } catch {
    return "";
  }
}

/** `─` frame, `▌ 42 │ text`, tinted error rows and `⋮` gaps. */
export function renderFrameRows(rows: FrameRow[], width: number, theme: FrameTheme): string[] {
  const numbers = rows.flatMap((row) => (row.kind === "line" ? [row.no] : []));
  const numberWidth = String(Math.max(1, ...numbers)).length;
  // indent + marker + space + number + " │ "
  const prefixWidth = INDENT.length + 2 + numberWidth + 3;
  const textWidth = width - prefixWidth;
  if (textWidth < 8) {
    return rows.flatMap((row) =>
      row.kind === "line" ? [truncateToWidth(`${INDENT}${theme.fg("toolOutput", row.text)}`, width)] : [],
    );
  }

  const separator = theme.fg("dim", " │ ");
  const frame = `${INDENT}${theme.fg("dim", "─".repeat(width - INDENT.length))}`;
  const tint = errorBg(theme);
  const lines = [frame];
  for (const row of rows) {
    if (row.kind === "gap") {
      const label = row.label ? ` ${theme.fg("muted", row.label)}` : "";
      lines.push(truncateToWidth(`${INDENT}  ${theme.fg("dim", `${"⋮".padStart(numberWidth)} │`)}${label}`, width));
      continue;
    }
    const number = String(row.no).padStart(numberWidth);
    const text = cutText(row.text, textWidth);
    if (row.tone === undefined) {
      lines.push(`${INDENT}  ${theme.fg("dim", number)}${separator}${theme.fg("toolOutput", text)}`);
      continue;
    }
    const color = row.tone === "hit" ? "accent" : row.tone;
    const body = `${theme.fg(color, "▌")} ${theme.fg(color, number)}${separator}${theme.fg(row.tone === "hit" ? "toolOutput" : color, text)}`;
    if (row.tone === "error" && tint) {
      const used = prefixWidth + visibleWidth(text);
      lines.push(`${INDENT}${tint}${body}${tint}${" ".repeat(Math.max(0, width - used))}${BG_RESET}`);
    } else {
      lines.push(`${INDENT}${body}`);
    }
  }
  lines.push(frame);
  return lines;
}

/** Render text and framed blocks at the given width. */
export function renderFrameBlocks(blocks: FrameBlock[], width: number, theme: FrameTheme): string[] {
  return blocks.flatMap((block) =>
    block.kind === "rows"
      ? renderFrameRows(block.rows, width, theme)
      : [truncateToWidth(`${INDENT}${theme.fg("muted", block.text)}`, width)],
  );
}

/** Minimal width-aware component: Pi calls `render(width)` on each paint. */
export class Lines {
  private readonly build: (width: number) => string[];
  constructor(build: (width: number) => string[]) {
    this.build = build;
  }
  render(width: number): string[] {
    return this.build(width);
  }
  invalidate(): void {}
}
