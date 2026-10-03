import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildLineDiff,
  contentRows,
  parseDisplayDiff,
  serializeDisplayDiff,
  splitLines,
} from "./diff-format.ts";
import type { DiffView } from "./diff-render.ts";

/** Files above this size are not compared. */
export const MAX_COMPARE_BYTES = 512_000;

/** Stored in the write result's details, so restored sessions render the same. */
export type WritePreview =
  | { kind: "created" }
  | { kind: "diff"; diff: string }
  | { kind: "unchanged" }
  | { kind: "omitted"; lines: number };

export type PreviousFile =
  | { exists: false }
  | { exists: true; content?: string };

/** Same rules as Pi's write path: strip a leading `@`, expand `~`, resolve from cwd. */
export function resolveWritePath(path: string, cwd: string): string {
  let target = path.startsWith("@") ? path.slice(1) : path;
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
    target = join(homedir(), target.slice(1));
  }
  return resolve(cwd, target);
}

/** Read the file a write is about to replace. Undefined when it cannot be read. */
export async function readPreviousFile(path: string): Promise<PreviousFile | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    if (info.size > MAX_COMPARE_BYTES) return { exists: true };
    const buffer = await readFile(path);
    // Binary files are not shown as text.
    if (buffer.includes(0)) return { exists: true };
    return { exists: true, content: buffer.toString("utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { exists: false } : undefined;
  }
}

export function buildWritePreview(previous: PreviousFile, content: string): WritePreview {
  if (!previous.exists) return { kind: "created" };
  if (previous.content === undefined) return { kind: "omitted", lines: splitLines(content).length };
  const rows = buildLineDiff(previous.content, content);
  if (rows === undefined) return { kind: "omitted", lines: splitLines(content).length };
  if (rows.length === 0) return { kind: "unchanged" };
  return { kind: "diff", diff: serializeDisplayDiff(rows) };
}

function isWritePreview(value: unknown): value is WritePreview {
  return (
    typeof value === "object" &&
    value !== null &&
    ["created", "diff", "unchanged", "omitted"].includes((value as { kind?: string }).kind ?? "")
  );
}

/** View for a write result; results without a preview show the written content. */
export function writeView(details: unknown, content: string): DiffView {
  const preview = (details as { writePreview?: unknown } | undefined)?.writePreview;
  if (!isWritePreview(preview)) {
    return { kind: "content", rows: contentRows(content), label: "wrote" };
  }
  switch (preview.kind) {
    case "created":
      return { kind: "content", rows: contentRows(content), label: "new file" };
    case "diff":
      return { kind: "diff", rows: parseDisplayDiff(preview.diff) };
    case "unchanged":
      return { kind: "unchanged" };
    default:
      return { kind: "omitted", lines: preview.lines };
  }
}
