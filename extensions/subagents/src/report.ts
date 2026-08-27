import type { SubagentErrorReport, SubagentReport } from "./domain.ts";

type ReportError = SubagentErrorReport;

const REPORT_PATTERN = /<subagent-report>\s*([\s\S]*?)\s*<\/subagent-report>/gi;
const OUTCOMES = new Set<SubagentReport["outcome"]>([
  "success",
  "failed",
  "blocked",
  "timeout",
  "cancelled",
]);
const VALID_ERROR_PHASES = new Set([
  "analysis",
  "implementation",
  "test",
  "environment",
  "runtime",
] as const);
const MAX_TEXT = 4_096;

function bounded(value: string) {
  return value.slice(0, MAX_TEXT);
}

function cleanPayload(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseCandidate(value: string): SubagentReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanPayload(value));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.outcome !== "string" ||
    !OUTCOMES.has(record.outcome as SubagentReport["outcome"]) ||
    typeof record.summary !== "string" ||
    record.summary.trim().length === 0 ||
    typeof record.needsParentDecision !== "boolean" ||
    !Array.isArray(record.changes) ||
    !record.changes.every((item) => typeof item === "string") ||
    !Array.isArray(record.tests)
  )
    return undefined;

  const tests: Array<SubagentReport["tests"][number] | undefined> =
    record.tests.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return undefined;
      const test = item as Record<string, unknown>;
      if (typeof test.command !== "string" || typeof test.passed !== "boolean")
        return undefined;
      return {
        command: bounded(test.command),
        passed: test.passed,
        ...(typeof test.output === "string"
          ? { output: bounded(test.output) }
          : {}),
      };
    });
  if (tests.some((item) => item === undefined)) return undefined;

  let error: SubagentReport["error"];
  if (record.error !== undefined) {
    if (typeof record.error === "string") {
      if (record.error.trim().length === 0) return undefined;
      error = { phase: "runtime", message: bounded(record.error) };
    } else if (
      record.error &&
      typeof record.error === "object" &&
      !Array.isArray(record.error)
    ) {
      const rawError = record.error as Record<string, unknown>;
      if (
        typeof rawError.phase !== "string" ||
        !VALID_ERROR_PHASES.has(rawError.phase as ReportError["phase"]) ||
        typeof rawError.message !== "string"
      )
        return undefined;
      error = {
        phase: rawError.phase as ReportError["phase"],
        message: bounded(rawError.message),
        ...(typeof rawError.cause === "string"
          ? { cause: bounded(rawError.cause) }
          : {}),
        ...(typeof rawError.recovery === "string"
          ? { recovery: bounded(rawError.recovery) }
          : {}),
      };
    } else {
      return undefined;
    }
  }

  const outcome = record.outcome as SubagentReport["outcome"];
  if (outcome !== "success" && error === undefined) return undefined;

  return {
    outcome,
    summary: bounded(record.summary),
    changes: record.changes
      .map((item) => bounded(item as string))
      .slice(0, 100),
    tests: tests as Array<SubagentReport["tests"][number]>,
    ...(error === undefined ? {} : { error }),
    needsParentDecision: record.needsParentDecision === true,
  };
}

/**
 * Parse the last valid report in a transcript. Terminal scrollback commonly
 * contains the launch prompt before the assistant output; that prompt itself
 * includes the report tags with a `...` placeholder and must be ignored.
 */
export function parseStructuredReport(
  text: string,
): SubagentReport | undefined {
  let valid: SubagentReport | undefined;
  for (const match of text.matchAll(REPORT_PATTERN)) {
    const candidate = parseCandidate(match[1] ?? "");
    if (candidate) valid = candidate;
  }
  return valid;
}

export function hasStructuredReport(text: string) {
  return parseStructuredReport(text) !== undefined;
}
