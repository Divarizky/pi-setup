import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bgSequence, mixRgb, paintBackground, parseAnsiRgb, type Rgb } from "./color.ts";
import {
  changedBlocks,
  describeBlocks,
  diffRowStats,
  inlineSpans,
  meterSlots,
  meterSplit,
  pairChangedRows,
  type DiffRow,
  type DiffStats,
} from "./diff-format.ts";
import { Block, controlSuffix, fitLine, fitWithSuffix, RESULT_INDENT, RESULT_PREFIX } from "./tool-chrome.ts";
import { plural } from "./tool-format.ts";

/** Rows shown when a diff is expanded; the rest collapse into a count. */
export const MAX_DIFF_ROWS = 200;
const ROW_TINT = 0.16;
const SPAN_TINT = 0.34;
const BG_RESET = "\x1b[49m";
const FALLBACK_ADD: Rgb = { r: 84, g: 190, b: 118 };
const FALLBACK_REMOVE: Rgb = { r: 232, g: 95, b: 122 };
const MAX_HIGHLIGHT_CACHE = 4_000;

type Palette = { addRow: string; addSpan: string; removeRow: string; removeSpan: string };

const palettes = new Map<string, Palette>();
const highlights = new Map<string, string>();

/** Row tints mixed from the theme's diff colors into its message background. */
function paletteFor(theme: Theme): Palette {
  const addFg = theme.getFgAnsi("toolDiffAdded");
  const removeFg = theme.getFgAnsi("toolDiffRemoved");
  const baseBg = theme.getBgAnsi("userMessageBg");
  const mode = theme.getColorMode();
  // `appearance` only exists on newer Pi versions.
  const appearance = (theme as { appearance?: string }).appearance;
  const key = `${addFg}|${removeFg}|${baseBg}|${mode}|${appearance}`;
  const cached = palettes.get(key);
  if (cached) return cached;

  const base =
    parseAnsiRgb(baseBg) ??
    (appearance === "light" ? { r: 255, g: 255, b: 255 } : { r: 13, g: 17, b: 23 });
  const add = parseAnsiRgb(addFg) ?? FALLBACK_ADD;
  const remove = parseAnsiRgb(removeFg) ?? FALLBACK_REMOVE;
  const palette = {
    addRow: bgSequence(mixRgb(base, add, ROW_TINT), mode),
    addSpan: bgSequence(mixRgb(base, add, SPAN_TINT), mode),
    removeRow: bgSequence(mixRgb(base, remove, ROW_TINT), mode),
    removeSpan: bgSequence(mixRgb(base, remove, SPAN_TINT), mode),
  };
  palettes.set(key, palette);
  return palette;
}

/** Syntax-highlight one line; falls back to plain output color. */
export function highlightLine(text: string, language: string | undefined, theme: Theme): string {
  if (!language || text.trim() === "") return theme.fg("toolOutput", text);
  const key = `${language}\u0000${text}`;
  const cached = highlights.get(key);
  if (cached !== undefined) return cached;
  let styled: string;
  try {
    styled = highlightCode(text, language)[0] ?? text;
  } catch {
    styled = theme.fg("toolOutput", text);
  }
  if (highlights.size >= MAX_HIGHLIGHT_CACHE) highlights.clear();
  highlights.set(key, styled);
  return styled;
}

/** Longest prefix of `text` that fits `max` columns, leaving room for "…". */
export function cutToWidth(text: string, max: number): { text: string; cut: boolean } {
  if (visibleWidth(text) <= max) return { text, cut: false };
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = visibleWidth(char);
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return { text: out, cut: true };
}

function rowNumber(row: DiffRow): number | undefined {
  return row.kind === "remove" ? row.oldNo : row.newNo;
}

/** Framed diff body: `▌ 42 │ code` with tinted rows and highlighted changes. */
export function renderDiffRows(
  rows: DiffRow[],
  width: number,
  theme: Theme,
  filePath: string | undefined,
): string[] {
  const numberWidth = String(Math.max(1, ...rows.map((row) => rowNumber(row) ?? 0))).length;
  // indent + marker + space + number + " │ "
  const prefixWidth = RESULT_INDENT.length + 2 + numberWidth + 3;
  const codeWidth = width - prefixWidth;
  if (codeWidth < 8) return [];

  const language = filePath ? getLanguageFromPath(filePath) : undefined;
  const palette = paletteFor(theme);
  const pairs = pairChangedRows(rows);
  const separator = theme.fg("dim", " │ ");
  const frame = `${RESULT_INDENT}${theme.fg("dim", "─".repeat(width - RESULT_INDENT.length))}`;
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  const lines = [frame];

  for (const row of shown) {
    if (row.kind === "gap") {
      lines.push(`${RESULT_INDENT}  ${theme.fg("dim", `${"⋮".padStart(numberWidth)} │`)}`);
      continue;
    }
    const number = String(rowNumber(row) ?? "").padStart(numberWidth);
    const { text, cut } = cutToWidth(row.text, codeWidth);
    const code = highlightLine(text, language, theme) + (cut ? theme.fg("dim", "…") : "");

    if (row.kind === "context") {
      lines.push(`${RESULT_INDENT}  ${theme.fg("dim", number)}${separator}${code}`);
      continue;
    }

    const added = row.kind === "add";
    const color = added ? "toolDiffAdded" : "toolDiffRemoved";
    const rowBg = added ? palette.addRow : palette.removeRow;
    const spanBg = added ? palette.addSpan : palette.removeSpan;
    const pair = pairs.get(row);
    const spans = pair
      ? added
        ? inlineSpans(pair.text, row.text).new
        : inlineSpans(row.text, pair.text).old
      : [];
    const used = prefixWidth + visibleWidth(text) + (cut ? 1 : 0);
    lines.push(
      `${RESULT_INDENT}${rowBg}${theme.fg(color, "▌")} ${theme.fg(color, number)}${separator}` +
        `${paintBackground(code, rowBg, spanBg, spans)}${rowBg}${" ".repeat(Math.max(0, width - used))}${BG_RESET}`,
    );
  }

  if (rows.length > shown.length) {
    lines.push(
      `${RESULT_INDENT}  ${theme.fg("muted", `⋯ ${plural(rows.length - shown.length, "more line")}`)}`,
    );
  }
  lines.push(frame);
  return lines;
}

function statsText(theme: Theme, stats: DiffStats, showRemoved: boolean): string {
  const added = theme.fg("toolDiffAdded", `+${stats.added}`);
  return showRemoved ? `${added} ${theme.fg("toolDiffRemoved", `−${stats.removed}`)}` : added;
}

function meterText(theme: Theme, stats: DiffStats, slots: number): string {
  if (slots === 0) return "";
  const split = meterSplit(slots, stats);
  return (
    theme.fg("dim", "[") +
    theme.fg("toolDiffAdded", "━".repeat(split.added)) +
    theme.fg("toolDiffRemoved", "━".repeat(split.removed)) +
    theme.fg("dim", "]")
  );
}

export type DiffView =
  /** Edit or overwrite: rows from a display diff. */
  | { kind: "diff"; rows: DiffRow[] }
  /** New file, or a write whose previous content is unknown. */
  | { kind: "content"; rows: DiffRow[]; label: "new file" | "wrote" }
  | { kind: "unchanged" }
  | { kind: "omitted"; lines: number };

/**
 * Collapsed: `+2 −1  [━━━━]  2 changed blocks: lines 42–43 and line 88`.
 * Expanded adds the framed diff below.
 */
export function diffResultBlock(
  view: DiffView,
  expanded: boolean,
  theme: Theme,
  filePath: string | undefined,
): Block {
  return new Block((width) => {
    const prefix = theme.fg("dim", RESULT_PREFIX);
    if (view.kind === "unchanged") {
      return [fitLine(`${prefix}${theme.fg("muted", "no changes")}`, width, theme)];
    }
    if (view.kind === "omitted") {
      const note = `rewrote ${plural(view.lines, "line")}, diff too large to show`;
      return [fitLine(`${prefix}${theme.fg("muted", note)}`, width, theme)];
    }

    const stats = diffRowStats(view.rows);
    const control = view.rows.length > 0 ? controlSuffix(theme, expanded) : "";
    const blocks = view.kind === "diff" ? changedBlocks(view.rows) : [];
    const describe = (room: number) =>
      view.kind === "diff"
        ? describeBlocks(blocks, room)
        : view.label === "new file"
          ? `new file, ${plural(stats.added, "line")}`
          : `wrote ${plural(stats.added, "line")}`;

    // The description matters more than the meter: shrink, then drop the meter first.
    let summary = "";
    for (const slots of [meterSlots(width), 8, 0]) {
      const meter = meterText(theme, stats, slots);
      const head = `${prefix}${statsText(theme, stats, view.kind === "diff")}${meter ? `  ${meter}` : ""}`;
      const room = width - visibleWidth(head) - visibleWidth(control) - 2;
      const description = describe(room);
      const fits = description !== "" && [...description].length <= room;
      summary = fitWithSuffix(
        description ? `${head}  ${theme.fg("muted", description)}` : head,
        control,
        width,
        theme,
      );
      if (fits) break;
    }

    if (!expanded) return [summary];
    return [summary, ...renderDiffRows(view.rows, width, theme, filePath)];
  });
}
