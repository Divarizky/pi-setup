import { keyText, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { expandControl } from "./tool-format.ts";
import { currentTuiMode } from "./ui-binding.ts";

export const RESULT_PREFIX = "  ⎿  ";
export const RESULT_INDENT = "     ";

// Not re-exported from the package index, so derive it from ToolDefinition.
export type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
export type ToolResultLike = {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
};

export function resultText(result: ToolResultLike): string {
  return (result.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function expandKeyText(): string {
  try {
    return keyText("app.tools.expand");
  } catch {
    return "ctrl+o";
  }
}

/** Styled expand/collapse control, or "" when there is nothing to toggle. */
export function controlSuffix(theme: Theme, expanded: boolean): string {
  const control = expandControl(currentTuiMode(), expanded, expandKeyText());
  if (!control) return "";
  return control.button
    ? `  ${theme.underline(theme.fg("accent", control.text))}`
    : ` ${theme.fg("dim", control.text)}`;
}

/** Fit a styled line to the width, keeping a trailing control visible. */
export function fitWithSuffix(line: string, suffix: string, width: number, theme: Theme): string {
  const room = width - visibleWidth(suffix);
  if (room <= 0) return truncateToWidth(line, width, theme.fg("dim", "…"));
  const body = visibleWidth(line) > room ? truncateToWidth(line, room, theme.fg("dim", "…")) : line;
  return `${body}${suffix}`;
}

export function fitLine(line: string, width: number, theme: Theme): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, theme.fg("dim", "…")) : line;
}

/**
 * Width-aware component. Static blocks cache per width; live blocks rebuild on
 * every render so spinners and timers advance on a plain render request.
 */
export class Block {
  private readonly build: (width: number) => string[];
  private readonly live: boolean;
  private cache: { width: number; lines: string[] } | undefined;

  constructor(build: (width: number) => string[], live = false) {
    this.build = build;
    this.live = live;
  }

  render(width: number): string[] {
    if (!this.live && this.cache?.width === width) return this.cache.lines;
    const lines = this.build(width);
    if (!this.live) this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
