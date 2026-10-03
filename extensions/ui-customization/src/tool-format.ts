import { isAbsolute, relative, sep } from "node:path";

/** Max output lines shown when a tool result is expanded. */
export const EXPANDED_MAX_LINES = 20;
const MAX_ARG_CHARS = 80;

export function clip(text: string, max = MAX_ARG_CHARS): string {
  const single = text.replace(/\s+/g, " ").trim();
  const chars = [...single];
  if (chars.length <= max) return single;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Relative to cwd when inside it, `~`-prefixed when inside home. */
export function shortenPath(path: string, cwd: string, home: string): string {
  if (!path) return "";
  if (isAbsolute(path)) {
    const fromCwd = relative(cwd, path);
    if (fromCwd && !fromCwd.startsWith("..") && !isAbsolute(fromCwd)) {
      return fromCwd.split(sep).join("/");
    }
    const fromHome = relative(home, path);
    if (fromHome && !fromHome.startsWith("..") && !isAbsolute(fromHome)) {
      return `~/${fromHome.split(sep).join("/")}`;
    }
  }
  return path.split("\\").join("/");
}

export type CallTitle = { label: string; arg: string };

export function callTitle(
  toolName: string,
  args: Record<string, unknown> | undefined,
  cwd: string,
  home: string,
): CallTitle {
  const path =
    typeof args?.path === "string" ? shortenPath(args.path, cwd, home) : "";
  switch (toolName) {
    case "read": {
      const offset = typeof args?.offset === "number" ? args.offset : undefined;
      const limit = typeof args?.limit === "number" ? args.limit : undefined;
      let range = "";
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        range = limit !== undefined ? `:${start}-${start + limit - 1}` : `:${start}`;
      }
      return { label: "read", arg: clip(`${path}${range}`) };
    }
    case "bash":
      return {
        label: "bash",
        arg: clip(typeof args?.command === "string" ? args.command : ""),
      };
    case "edit":
      return { label: "edit", arg: clip(path) };
    case "write":
      return { label: "write", arg: clip(path) };
    default:
      return { label: toolName, arg: "" };
  }
}

export function countLines(text: string): number {
  if (!text) return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.split("\n").length;
}

export type DiffStats = { added: number; removed: number };

/** Count changed lines in Pi's display diff (`+12 line` / `-12 line`). */
export function diffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

export type ResultSummaryInput = {
  toolName: string;
  text: string;
  isError: boolean;
  hasImage?: boolean;
  diff?: string;
  writeContent?: string;
  truncatedFrom?: number;
};

/** Pi appends a status line such as `Command exited with code 3` to bash errors. */
export function bashErrorStatus(text: string): string | undefined {
  const exit = /Command exited with code (\d+)/.exec(text);
  if (exit) return `Error: exit code ${exit[1]}`;
  const status = /Command (timed out after \d+ seconds|aborted|terminated without an exit code)/.exec(text);
  return status ? `Error: command ${status[1]}` : undefined;
}

/** One-line collapsed summary shown after `⎿`. */
export function resultSummary(input: ResultSummaryInput): string {
  if (input.isError) {
    const status =
      input.toolName === "bash" ? bashErrorStatus(input.text) : undefined;
    return status ?? clip(firstLine(input.text) || "Error", 120);
  }
  switch (input.toolName) {
    case "read": {
      if (input.hasImage) return "Read image";
      const read = `Read ${plural(countLines(input.text), "line")}`;
      return input.truncatedFrom
        ? `${read} (truncated from ${input.truncatedFrom})`
        : read;
    }
    case "bash": {
      const lines = countLines(input.text.trim());
      return lines === 0 ? "(No output)" : plural(lines, "line");
    }
    case "edit": {
      if (!input.diff) return "Applied";
      const { added, removed } = diffStats(input.diff);
      return `Added ${plural(added, "line")}, removed ${plural(removed, "line")}`;
    }
    case "write":
      return `Wrote ${plural(countLines(input.writeContent ?? ""), "line")}`;
    default:
      return "";
  }
}

export type Preview = { lines: string[]; hidden: number };

function splitOutput(text: string): string[] {
  const all = text.replace(/\n+$/, "").split("\n");
  return all.length === 1 && all[0] === "" ? [] : all;
}

export function previewLines(text: string, max: number): Preview {
  const all = splitOutput(text);
  if (all.length <= max) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, max), hidden: all.length - max };
}

/** Last `max` lines, for output that is still streaming. */
export function tailLines(text: string, max: number): Preview {
  const all = splitOutput(text);
  if (all.length <= max) return { lines: all, hidden: 0 };
  return { lines: all.slice(-max), hidden: all.length - max };
}

export type TuiModeName = "regular" | "fullscreen";

/**
 * Expand control shown next to a tool summary. Fullscreen gets a clickable
 * button (Pi toggles the card on click); regular mode gets the key hint,
 * because the terminal owns the mouse there.
 */
export function expandControl(
  mode: TuiModeName,
  expanded: boolean,
  expandKey: string,
): { text: string; button: boolean } | undefined {
  if (mode === "fullscreen") {
    return { text: expanded ? "click to collapse" : "click to expand", button: true };
  }
  if (expanded) return undefined;
  return { text: `(${expandKey || "ctrl+o"} to expand)`, button: false };
}
