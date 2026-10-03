/** Same frames and interval as Pi's built-in Loader spinner. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

const MAX_TITLE_CHARS = 60;
const TITLE_PATTERN = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*/g;

export function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/\[([^\]]+?)\]\([^)]*?\)/g, "$1")
    .trim();
}

/** Latest `**bold**` title in the thinking text, else its first line. */
export function extractThinkingTitle(text: string): string {
  let latest: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  TITLE_PATTERN.lastIndex = 0;
  while ((match = TITLE_PATTERN.exec(text)) !== null) latest = match;
  const raw = latest?.[1]?.trim().length
    ? latest[1].trim()
    : (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "");
  return stripMarkdownInline(raw);
}

export function truncateLabel(text: string, max = MAX_TITLE_CHARS): string {
  const single = text.replace(/\s+/g, " ").trim();
  if ([...single].length <= max) return single;
  return `${[...single].slice(0, max - 1).join("").trimEnd()}…`;
}

export function formatThoughtDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export type ThinkingRun = { start: number; end: number; text: string };

/**
 * Consecutive thinking blocks with visible text, grouped exactly like Pi's
 * AssistantMessageComponent, so run N matches Pi's Nth thinking region.
 */
export function thinkingRuns(content: unknown): ThinkingRun[] {
  if (!Array.isArray(content)) return [];
  const runs: ThinkingRun[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i]?.type !== "thinking") continue;
    const start = i;
    const parts: string[] = [];
    for (; i < content.length && content[i]?.type === "thinking"; i += 1) {
      const thinking = content[i]?.thinking;
      if (typeof thinking === "string" && thinking.trim()) parts.push(thinking.trim());
    }
    i -= 1;
    if (parts.length > 0) runs.push({ start, end: i, text: parts.join("\n\n") });
  }
  return runs;
}

/** Split text around a highlight band that sweeps left to right. */
export function shimmerParts(
  text: string,
  frame: number,
): [before: string, highlight: string, after: string] {
  const chars = [...text];
  if (chars.length === 0) return ["", "", ""];
  const band = Math.max(1, Math.min(5, Math.ceil(chars.length * 0.28)));
  const start = (frame % (chars.length + band)) - band;
  const end = start + band;
  return [
    chars.slice(0, Math.max(0, start)).join(""),
    chars.slice(Math.max(0, start), Math.max(0, end)).join(""),
    chars.slice(Math.max(0, end)).join(""),
  ];
}

