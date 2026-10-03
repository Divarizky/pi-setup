import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth, highlightLine } from "./diff-render.ts";
import { fitLine, RESULT_INDENT } from "./tool-chrome.ts";

/** One row of framed output: a numbered line or a `⋮` gap with a note. */
export type OutputRow =
  | { kind: "line"; no: number; text: string; tone?: "error" | "warning" }
  | { kind: "gap"; label: string };

const BG_RESET = "\x1b[49m";

function errorBg(theme: Theme): string {
  try {
    return theme.getBgAnsi("toolErrorBg");
  } catch {
    return "";
  }
}

/**
 * Framed output in the same layout as the edit/write diff:
 * `─` frame, `▌ 42 │ text`, error rows tinted, `⋮` for skipped lines.
 */
export function renderOutputRows(
  rows: OutputRow[],
  width: number,
  theme: Theme,
  language?: string,
): string[] {
  const numbers = rows.flatMap((row) => (row.kind === "line" ? [row.no] : []));
  const numberWidth = String(Math.max(1, ...numbers)).length;
  // indent + marker + space + number + " │ "
  const prefixWidth = RESULT_INDENT.length + 2 + numberWidth + 3;
  const codeWidth = width - prefixWidth;
  if (codeWidth < 8) {
    return rows.flatMap((row) =>
      row.kind === "line" ? [fitLine(`${RESULT_INDENT}${theme.fg("toolOutput", row.text)}`, width, theme)] : [],
    );
  }

  const separator = theme.fg("dim", " │ ");
  const frame = `${RESULT_INDENT}${theme.fg("dim", "─".repeat(width - RESULT_INDENT.length))}`;
  const tint = errorBg(theme);
  const lines = [frame];

  for (const row of rows) {
    if (row.kind === "gap") {
      const label = row.label ? ` ${theme.fg("muted", row.label)}` : "";
      lines.push(fitLine(`${RESULT_INDENT}  ${theme.fg("dim", `${"⋮".padStart(numberWidth)} │`)}${label}`, width, theme));
      continue;
    }
    const number = String(row.no).padStart(numberWidth);
    const { text, cut } = cutToWidth(row.text, codeWidth);
    const ellipsis = cut ? theme.fg("dim", "…") : "";

    if (row.tone === undefined) {
      lines.push(`${RESULT_INDENT}  ${theme.fg("dim", number)}${separator}${highlightLine(text, language, theme)}${ellipsis}`);
      continue;
    }

    const color = row.tone;
    const body = `${theme.fg(color, "▌")} ${theme.fg(color, number)}${separator}${theme.fg(color, text)}${ellipsis}`;
    if (row.tone === "error" && tint) {
      const used = prefixWidth + visibleWidth(text) + (cut ? 1 : 0);
      lines.push(`${RESULT_INDENT}${tint}${body}${tint}${" ".repeat(Math.max(0, width - used))}${BG_RESET}`);
    } else {
      lines.push(`${RESULT_INDENT}${body}`);
    }
  }

  lines.push(frame);
  return lines;
}
