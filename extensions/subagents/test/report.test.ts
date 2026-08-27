import assert from "node:assert/strict";
import test from "node:test";
import { hasStructuredReport, parseStructuredReport } from "../src/report.ts";

const validReport = {
  outcome: "success",
  summary: "Finished after inspecting the worktree.",
  changes: ["updated source"],
  tests: [{ command: "npm test", passed: true }],
  needsParentDecision: false,
};

test("report parser ignores the launch-prompt placeholder and uses the valid report", () => {
  const text = [
    "The launch prompt was echoed by the terminal.",
    "Finish with one report: <subagent-report>...</subagent-report>",
    `<subagent-report>${JSON.stringify(validReport)}</subagent-report>`,
  ].join("\n");

  assert.deepEqual(parseStructuredReport(text), validReport);
  assert.equal(hasStructuredReport(text), true);
});

test("report parser accepts a fenced JSON payload and string errors", () => {
  const text = [
    "<subagent-report>",
    "```json",
    JSON.stringify({
      outcome: "failed",
      summary: "The test could not run.",
      changes: [],
      tests: [
        { command: "./gradlew test", passed: false, output: "SDK missing" },
      ],
      error: "Android SDK is not configured.",
      needsParentDecision: true,
    }),
    "```",
    "</subagent-report>",
  ].join("\n");

  const report = parseStructuredReport(text);
  assert.equal(report?.outcome, "failed");
  assert.equal(report?.error?.phase, "runtime");
  assert.equal(report?.error?.message, "Android SDK is not configured.");
});

test("report parser selects the last valid report when earlier tags are invalid", () => {
  const text = [
    "<subagent-report>{not json}</subagent-report>",
    `<subagent-report>${JSON.stringify(validReport)}</subagent-report>`,
  ].join("\n");

  assert.equal(parseStructuredReport(text)?.summary, validReport.summary);
});

test("report parser rejects incomplete non-success reports", () => {
  const incomplete = {
    outcome: "failed",
    summary: "The task failed.",
    changes: [],
    tests: [],
  };
  assert.equal(
    parseStructuredReport(
      `<subagent-report>${JSON.stringify(incomplete)}</subagent-report>`,
    ),
    undefined,
  );
  assert.equal(
    parseStructuredReport(
      `<subagent-report>${JSON.stringify({ ...validReport, needsParentDecision: undefined })}</subagent-report>`,
    ),
    undefined,
  );
});
