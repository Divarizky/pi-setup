import { sanitizeTerminalOutput } from "./command-runner.ts";

const PREVIEW_HEAD_LINES = 20;
const PREVIEW_TAIL_LINES = 20;
const PREVIEW_LINE_MAX_CHARS = 500;
const PREVIEW_MAX_LINES = PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES;

export interface OutputPreview {
  head: string[];
  tail: string[];
  totalLines: number;
}

/** Collects a bounded head/tail view without retaining an unbounded line array. */
export function collectOutputPreview(raw: string): OutputPreview {
  const head: string[] = [];
  const tail: string[] = [];
  const currentLineChars: string[] = [];
  let currentLineStart = 0;
  let currentLineTruncated = false;
  let pendingCarriageReturn = false;
  let tailStart = 0;
  let totalLines = 0;

  const currentLine = () => currentLineStart === 0
    ? currentLineChars.join("")
    : [
        ...currentLineChars.slice(currentLineStart),
        ...currentLineChars.slice(0, currentLineStart),
      ].join("");
  const resetCurrentLine = () => {
    currentLineChars.length = 0;
    currentLineStart = 0;
    currentLineTruncated = false;
  };
  const addLine = (line: string, truncated: boolean) => {
    const sanitized = sanitizeTerminalOutput(line);
    const needsEllipsis = truncated || sanitized.length > PREVIEW_LINE_MAX_CHARS;
    const bounded = needsEllipsis
      ? `…${sanitized.slice(-(PREVIEW_LINE_MAX_CHARS - 1))}`
      : sanitized;
    if (head.length < PREVIEW_HEAD_LINES) {
      head.push(bounded);
    } else if (tail.length < PREVIEW_TAIL_LINES) {
      tail.push(bounded);
    } else {
      tail[tailStart] = bounded;
      tailStart = (tailStart + 1) % PREVIEW_TAIL_LINES;
    }
    totalLines++;
  };
  const commitLine = () => {
    addLine(currentLine(), currentLineTruncated);
    resetCurrentLine();
  };

  for (const char of raw) {
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (char === "\n") {
        commitLine();
        continue;
      }
      resetCurrentLine();
    }

    if (char === "\r") {
      pendingCarriageReturn = true;
    } else if (char === "\n") {
      commitLine();
    } else if (currentLineChars.length < PREVIEW_LINE_MAX_CHARS) {
      currentLineChars.push(char);
    } else {
      currentLineChars[currentLineStart] = char;
      currentLineStart = (currentLineStart + 1) % PREVIEW_LINE_MAX_CHARS;
      currentLineTruncated = true;
    }
  }
  if (currentLineChars.length > 0 || currentLineTruncated) {
    addLine(currentLine(), currentLineTruncated);
  }

  const orderedTail = tailStart === 0
    ? tail
    : [...tail.slice(tailStart), ...tail.slice(0, tailStart)];
  return { head, tail: orderedTail, totalLines };
}

/** Formats a compact head/tail view with at most 40 output lines plus an omission marker. */
export function formatOutputPreview(preview: OutputPreview, requestedLines: number): string[] {
  const maxLines = Math.max(1, Math.min(PREVIEW_MAX_LINES, Math.floor(requestedLines) || 1));
  const totalLines = Math.max(0, Math.floor(preview.totalLines) || 0);
  if (totalLines === 0) return ["(no output)"];

  const knownLines = [...preview.head, ...preview.tail];
  if (totalLines <= maxLines) return knownLines.slice(0, totalLines);

  const headCount = Math.ceil(maxLines / 2);
  const tailCount = maxLines - headCount;
  const head = preview.head.slice(0, headCount);
  const tail = tailCount > 0 ? preview.tail.slice(-tailCount) : [];
  const omitted = Math.max(0, totalLines - head.length - tail.length);
  return [...head, `… +${omitted} lines omitted`, ...tail];
}
