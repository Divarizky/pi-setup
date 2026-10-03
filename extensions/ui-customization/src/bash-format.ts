export type BashIssue = "error" | "warning";

export type BashStatus = {
  /** Output without the status and truncation notices Pi appends. */
  output: string;
  exitCode?: number;
  /** Failure without an exit code, such as a timeout. */
  failure?: string;
};

const TRUNCATION_NOTICE = /\n*\[Showing (?:lines|last) [^\]\n]*Full output: [^\]\n]*\]\s*$/;
const EXIT_STATUS = /\n*Command exited with code (\d+)\s*$/;
const TIMEOUT_STATUS = /\n*Command timed out after (\d+) seconds\s*$/;
const OTHER_STATUS = /\n*Command (aborted|terminated without an exit code)\s*$/;

/** Split Pi's bash result text into output and exit status. */
export function parseBashResult(text: string, isError: boolean): BashStatus {
  let output = text;
  let exitCode: number | undefined;
  let failure: string | undefined;
  if (isError) {
    const exit = EXIT_STATUS.exec(output);
    const timeout = TIMEOUT_STATUS.exec(output);
    const other = OTHER_STATUS.exec(output);
    if (exit) {
      exitCode = Number(exit[1]);
      output = output.slice(0, exit.index);
    } else if (timeout) {
      failure = `timed out after ${timeout[1]}s`;
      output = output.slice(0, timeout.index);
    } else if (other) {
      failure = other[1] === "aborted" ? "aborted" : "no exit code";
      output = output.slice(0, other.index);
    } else {
      failure = "failed";
    }
  } else {
    exitCode = 0;
  }
  output = output.replace(TRUNCATION_NOTICE, "").replace(/\s+$/, "");
  // Pi writes this placeholder when a command prints nothing.
  if (output === "(no output)") output = "";
  return { output, exitCode, failure };
}

const ZERO_COUNT =
  /\b(?:0|no|zero)\s+(?:errors?|warnings?|failures?|failed|problems?)\b|\b(?:errors?|warnings?|failures?|failed|fail)\s*[:=]?\s*0\b/i;
const ERROR_LINE =
  /\b(?:errors?|failed|failures?|fatal|exception|panic)\b|\bfail\b|ERR!|✖|✗|❌|\bE\d{3,}\b/i;
const WARNING_LINE = /\b(?:warn|warnings?|deprecated)\b|⚠/i;

/** Keyword-based guess; counts like `0 errors` are not issues. */
export function classifyLine(line: string): BashIssue | undefined {
  if (!line.trim() || ZERO_COUNT.test(line)) return undefined;
  if (ERROR_LINE.test(line)) return "error";
  if (WARNING_LINE.test(line)) return "warning";
  return undefined;
}

export function countIssues(lines: string[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const line of lines) {
    const issue = classifyLine(line);
    if (issue === "error") errors += 1;
    else if (issue === "warning") warnings += 1;
  }
  return { errors, warnings };
}

export function outputLines(output: string): string[] {
  return output === "" ? [] : output.split("\n").map((line) => line.replace(/\r$/, ""));
}

export type NumberedLine = { no: number; text: string };

/**
 * The last `limit` lines, numbered by their position in the full output.
 * `total` covers lines Pi already dropped when it truncated the output.
 */
export function numberedTail(
  lines: string[],
  total: number,
  limit: number,
): { hidden: number; rows: NumberedLine[] } {
  const shown = lines.slice(-limit);
  const last = Math.max(total, lines.length);
  const first = last - shown.length + 1;
  return {
    hidden: first - 1,
    rows: shown.map((text, index) => ({ no: first + index, text })),
  };
}

const READ_NOTICE =
  /\n*\[((?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)[^\]\n]*)\]\s*$/;

/** Split Pi's read output into file content and its trailing continuation notice. */
export function splitReadNotice(text: string): { content: string; notice?: string } {
  const match = READ_NOTICE.exec(text);
  const content = match ? text.slice(0, match.index) : text;
  return { content: content.replace(/\r?\n$/, ""), notice: match?.[1] };
}

/** `0.2s`, `12.4s`, `1m5s`. */
export function formatBashDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function lastNonEmptyLine(lines: string[]): string {
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k]!.trim()) return lines[k]!;
  }
  return "";
}
