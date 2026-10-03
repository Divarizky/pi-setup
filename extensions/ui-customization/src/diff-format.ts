/** Diff rows shared by the edit and write renderers. */
export type DiffKind = "add" | "remove" | "context" | "gap";

export type DiffRow = {
  kind: DiffKind;
  text: string;
  /** Line number in the old file (remove and context rows). */
  oldNo?: number;
  /** Line number in the new file (add and context rows). */
  newNo?: number;
  /** Position in the new file where a removed line used to be. */
  at?: number;
};

export type DiffStats = { added: number; removed: number };
export type ChangedBlock = { start: number; end: number };

const DIFF_ROW = /^([+\- ]) *(\d+) ?(.*)$/;
const GAP_ROW = /^ +\.\.\.$/;
/** Largest line matrix the write diff computes before giving up. */
export const MAX_LINE_DIFF_CELLS = 4_000_000;
const MAX_INLINE_CHARS = 700;
const MAX_INLINE_CELLS = 40_000;

export function normalizeCode(text: string): string {
  return text.replace(/\r$/, "").replace(/\t/g, "  ");
}

/**
 * Parse Pi's display diff (`+12 text`, `-12 text`, ` 12 text`, `   ...`).
 * Pi numbers context lines by the old file, so new-file numbers are derived
 * from the running offset between the two files.
 */
export function parseDisplayDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let delta = 0;
  for (const line of diff.split("\n")) {
    if (GAP_ROW.test(line)) {
      if (rows.at(-1)?.kind !== "gap") rows.push({ kind: "gap", text: "" });
      continue;
    }
    const match = DIFF_ROW.exec(line);
    if (!match) continue;
    const no = Number(match[2]);
    const text = normalizeCode(match[3] ?? "");
    if (match[1] === "+") {
      rows.push({ kind: "add", text, newNo: no });
      delta += 1;
    } else if (match[1] === "-") {
      rows.push({ kind: "remove", text, oldNo: no, at: no + delta });
      delta -= 1;
    } else {
      rows.push({ kind: "context", text, oldNo: no, newNo: no + delta });
    }
  }
  return rows;
}

/** Inverse of parseDisplayDiff, used to persist write diffs in tool details. */
export function serializeDisplayDiff(rows: DiffRow[]): string {
  const width = String(
    Math.max(1, ...rows.map((row) => row.oldNo ?? row.newNo ?? 0)),
  ).length;
  const pad = (no: number | undefined) => String(no ?? "").padStart(width, " ");
  return rows
    .map((row) => {
      switch (row.kind) {
        case "add":
          return `+${pad(row.newNo)} ${row.text}`;
        case "remove":
          return `-${pad(row.oldNo)} ${row.text}`;
        case "context":
          return ` ${pad(row.oldNo)} ${row.text}`;
        default:
          return ` ${" ".repeat(width)} ...`;
      }
    })
    .join("\n");
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(normalizeCode);
}

/** Every line of a new file as an added row. */
export function contentRows(content: string): DiffRow[] {
  return splitLines(content).map((text, index) => ({
    kind: "add" as const,
    text,
    newNo: index + 1,
  }));
}

type Op = { kind: "equal" | "add" | "remove"; text: string; oldNo?: number; newNo?: number };

/** Line diff with common prefix/suffix trimming; undefined when too large. */
function lineOps(oldLines: string[], newLines: string[]): Op[] | undefined {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  if ((a.length + 1) * (b.length + 1) > MAX_LINE_DIFF_CELLS) return undefined;

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const cols = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] =
        a[i] === b[j]
          ? dp[(i + 1) * cols + j + 1]! + 1
          : Math.max(dp[(i + 1) * cols + j]!, dp[i * cols + j + 1]!);
    }
  }

  const ops: Op[] = [];
  for (let k = 0; k < prefix; k += 1) {
    ops.push({ kind: "equal", text: oldLines[k]!, oldNo: k + 1, newNo: k + 1 });
  }
  let i = 0;
  let j = 0;
  let removes: Op[] = [];
  let adds: Op[] = [];
  const flush = () => {
    ops.push(...removes, ...adds);
    removes = [];
    adds = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      ops.push({ kind: "equal", text: a[i]!, oldNo: prefix + i + 1, newNo: prefix + j + 1 });
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!)
    ) {
      removes.push({ kind: "remove", text: a[i]!, oldNo: prefix + i + 1 });
      i += 1;
    } else {
      adds.push({ kind: "add", text: b[j]!, newNo: prefix + j + 1 });
      j += 1;
    }
  }
  flush();
  for (let k = 0; k < suffix; k += 1) {
    const oldNo = oldLines.length - suffix + k + 1;
    const newNo = newLines.length - suffix + k + 1;
    ops.push({ kind: "equal", text: oldLines[oldNo - 1]!, oldNo, newNo });
  }
  return ops;
}

/**
 * Display rows for an overwrite, with `context` unchanged lines around each
 * change, like Pi's edit diff. Empty when nothing changed, undefined when the
 * files are too large to compare.
 */
export function buildLineDiff(
  oldText: string,
  newText: string,
  context = 4,
): DiffRow[] | undefined {
  const ops = lineOps(splitLines(oldText), splitLines(newText));
  if (!ops) return undefined;
  if (!ops.some((op) => op.kind !== "equal")) return [];

  const keep = ops.map(() => false);
  ops.forEach((op, index) => {
    if (op.kind === "equal") return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(ops.length - 1, index + context);
      k += 1
    ) {
      keep[k] = true;
    }
  });

  const rows: DiffRow[] = [];
  let delta = 0;
  ops.forEach((op, index) => {
    if (op.kind === "add") {
      rows.push({ kind: "add", text: op.text, newNo: op.newNo });
      delta += 1;
    } else if (op.kind === "remove") {
      rows.push({ kind: "remove", text: op.text, oldNo: op.oldNo, at: op.oldNo! + delta });
      delta -= 1;
    } else if (keep[index]) {
      rows.push({ kind: "context", text: op.text, oldNo: op.oldNo, newNo: op.newNo });
    } else if (rows.at(-1)?.kind !== "gap") {
      rows.push({ kind: "gap", text: "" });
    }
  });
  return rows;
}

export function diffRowStats(rows: DiffRow[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "remove") removed += 1;
  }
  return { added, removed };
}

/**
 * Runs of consecutive changed rows, as new-file line ranges. A pure removal
 * points at the line where the removed text used to be.
 */
export function changedBlocks(rows: DiffRow[]): ChangedBlock[] {
  const blocks: ChangedBlock[] = [];
  let run: DiffRow[] = [];
  const close = () => {
    if (run.length === 0) return;
    const added = run.filter((row) => row.kind === "add").map((row) => row.newNo!);
    if (added.length > 0) {
      blocks.push({ start: Math.min(...added), end: Math.max(...added) });
    } else {
      const at = run[0]!.at ?? run[0]!.oldNo ?? 1;
      blocks.push({ start: at, end: at });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "add" || row.kind === "remove") run.push(row);
    else close();
  }
  close();
  return blocks;
}

function lineRange(block: ChangedBlock): string {
  return block.start === block.end
    ? `line ${block.start}`
    : `lines ${block.start}–${block.end}`;
}

/**
 * `2 changed blocks: lines 42–43 and line 88`, shortened with `and N more`
 * until it fits `maxWidth`. Returns "" when not even the count fits.
 */
export function describeBlocks(blocks: ChangedBlock[], maxWidth: number): string {
  const count = blocks.length;
  if (count === 0) return "";
  const noun = `${count} changed block${count === 1 ? "" : "s"}`;
  const ranges = blocks.map(lineRange);
  for (let shown = count; shown >= 1; shown -= 1) {
    const head = ranges.slice(0, shown);
    let list: string;
    if (shown === count) {
      list =
        count === 1
          ? head[0]!
          : `${head.slice(0, -1).join(", ")} and ${head.at(-1)}`;
    } else {
      list = `${head.join(", ")} and ${count - shown} more`;
    }
    const text = `${noun}: ${list}`;
    if ([...text].length <= maxWidth) return text;
  }
  return [...noun].length <= maxWidth ? noun : "";
}

/** Number of meter slots for a given render width. */
export function meterSlots(width: number): number {
  return Math.max(8, Math.min(16, Math.floor(width / 6)));
}

/** Split meter slots between additions and removals, keeping both visible. */
export function meterSplit(slots: number, stats: DiffStats): DiffStats {
  const total = stats.added + stats.removed;
  if (total === 0) return { added: 0, removed: 0 };
  let added = Math.round((stats.added / total) * slots);
  if (stats.added > 0 && added === 0) added = 1;
  if (stats.removed > 0 && added >= slots) added = slots - 1;
  return { added, removed: slots - added };
}

/** Pair the i-th removed line with the i-th added line in each changed run. */
export function pairChangedRows(rows: DiffRow[]): Map<DiffRow, DiffRow> {
  const pairs = new Map<DiffRow, DiffRow>();
  let removes: DiffRow[] = [];
  let adds: DiffRow[] = [];
  const close = () => {
    for (let k = 0; k < Math.min(removes.length, adds.length); k += 1) {
      pairs.set(removes[k]!, adds[k]!);
      pairs.set(adds[k]!, removes[k]!);
    }
    removes = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "remove") {
      if (adds.length > 0) close();
      removes.push(row);
    } else if (row.kind === "add") {
      adds.push(row);
    } else {
      close();
    }
  }
  close();
  return pairs;
}

export type Span = { start: number; end: number };
type Token = { value: string; start: number; end: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu)) {
    const start = match.index ?? 0;
    tokens.push({ value: match[0], start, end: start + match[0].length });
  }
  return tokens;
}

/** Changed non-space tokens as spans; whitespace between two changed tokens joins them. */
function changedSpans(tokens: Token[], changed: boolean[]): Span[] {
  const spans: Span[] = [];
  let open: Span | undefined;
  tokens.forEach((token, index) => {
    if (token.value.trim() === "") return;
    if (!changed[index]) {
      if (open) spans.push(open);
      open = undefined;
    } else if (open) {
      open.end = token.end;
    } else {
      open = { start: token.start, end: token.end };
    }
  });
  if (open) spans.push(open);
  return spans;
}

/**
 * Character spans that differ between a removed line and its paired added
 * line. Empty when the lines share nothing, since highlighting the whole line
 * adds no information beyond the row tint.
 */
export function inlineSpans(
  oldText: string,
  newText: string,
): { old: Span[]; new: Span[] } {
  const none = { old: [], new: [] };
  if (oldText.length > MAX_INLINE_CHARS || newText.length > MAX_INLINE_CHARS) return none;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if ((a.length + 1) * (b.length + 1) > MAX_INLINE_CELLS) return none;

  const cols = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] =
        a[i]!.value === b[j]!.value
          ? dp[(i + 1) * cols + j + 1]! + 1
          : Math.max(dp[(i + 1) * cols + j]!, dp[i * cols + j + 1]!);
    }
  }
  const changedA = a.map(() => true);
  const changedB = b.map(() => true);
  let i = 0;
  let j = 0;
  let sharedWords = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.value === b[j]!.value) {
      changedA[i] = false;
      changedB[j] = false;
      if (a[i]!.value.trim() !== "") sharedWords += 1;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  if (sharedWords === 0) return none;
  return { old: changedSpans(a, changedA), new: changedSpans(b, changedB) };
}
