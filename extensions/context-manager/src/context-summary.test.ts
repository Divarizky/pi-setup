import assert from "node:assert/strict";
import test from "node:test";
import {
  findSnippets,
  formatLineRange,
  formatSummary,
  summarizeOutput,
} from "./context-summary.ts";

test("summarizeOutput prioritizes errors and includes a compact preview", () => {
  const summary = summarizeOutput(
    "booting\nwarn: old config\nERROR: database unavailable\nfinished",
  );
  assert.equal(summary.totalLines, 4);
  assert.deepEqual(summary.errorLines, ["ERROR: database unavailable"]);
  assert.deepEqual(summary.warningLines, ["warn: old config"]);
  assert.match(formatSummary(summary, "dari test"), /Error penting/);
});

test("formatSummary uses a non-redundant cache source label", () => {
  const summary = summarizeOutput("line");
  assert.match(
    formatSummary(summary, "dari cache output-4777b12b"),
    /^\[context-manager\] Output dari cache output-4777b12b diringkas secara lokal/m,
  );
  assert.doesNotMatch(
    formatSummary(summary, "dari cache output-4777b12b"),
    /Output dari output output-/,
  );
});

test("findSnippets returns line-numbered context around a matching query", () => {
  const text = "one\ntwo\nDatabase connection failed\nfour\nfive";
  assert.deepEqual(findSnippets(text, "connection failed", 2), [
    "2: two\n3: Database connection failed\n4: four",
  ]);
});

test("findSnippets returns no results for an empty query", () => {
  assert.deepEqual(findSnippets("anything", "   ", 2), []);
});

test("findSnippets supports bounded context around a match", () => {
  assert.deepEqual(
    findSnippets("one\ntwo\nmatch\nfour\nfive", "match", 2, {
      before: 2,
      after: 1,
    }),
    ["1: one\n2: two\n3: match\n4: four"],
  );
});

test("formatLineRange returns numbered head and tail ranges", () => {
  assert.equal(formatLineRange("one\ntwo\nthree", 2, 3), "2: two\n3: three");
});
