import assert from "node:assert/strict";
import test from "node:test";
import {
  createContextStats,
  formatContextStats,
  recordSummary,
} from "./context-stats.ts";

test("recordSummary tracks original and retained output sizes", () => {
  const stats = createContextStats();
  recordSummary(stats, "a\nb\nc\nd", "summary");

  assert.equal(stats.summarizedOutputs, 1);
  assert.equal(stats.originalChars, 7);
  assert.equal(stats.retainedChars, 7);
  assert.equal(stats.originalLines, 4);
  assert.equal(stats.retainedLines, 1);
});

test("formatContextStats reports savings and inspect usage", () => {
  const stats = createContextStats();
  recordSummary(stats, "0123456789", "short");
  stats.inspectCalls = 2;

  const output = formatContextStats(stats);
  assert.match(output, /Output besar diringkas: 1/);
  assert.match(output, /Dihemat: 5 karakter, 0 baris \(50,0%\)/);
  assert.match(output, /Pemakaian ctx_inspect: 2/);
});
