import assert from "node:assert/strict";
import test from "node:test";
import {
  extractThinkingTitle,
  formatThoughtDuration,
  shimmerParts,
  SPINNER_FRAMES,
  stripMarkdownInline,
  thinkingRuns,
  truncateLabel,
} from "./thinking-format.ts";

test("stripMarkdownInline removes bold, code, links", () => {
  assert.equal(stripMarkdownInline("**Fix** `x` and [docs](http://x)"), "Fix x and docs");
  assert.equal(stripMarkdownInline("__under__ plain"), "under plain");
});

test("extractThinkingTitle takes latest bold title", () => {
  assert.equal(extractThinkingTitle("**First** body\n**Second** more"), "Second");
  assert.equal(extractThinkingTitle("no bold here\nsecond line"), "no bold here");
  assert.equal(extractThinkingTitle(""), "");
  assert.equal(extractThinkingTitle("**`Read` the file**"), "Read the file");
});

test("truncateLabel collapses whitespace and clips long titles", () => {
  assert.equal(truncateLabel("  a   b  "), "a b");
  const clipped = truncateLabel("x".repeat(100));
  assert.ok(clipped.endsWith("…"));
  assert.ok([...clipped].length <= 60);
});

test("formatThoughtDuration formats seconds and minutes", () => {
  assert.equal(formatThoughtDuration(0), "1s");
  assert.equal(formatThoughtDuration(12_400), "12s");
  assert.equal(formatThoughtDuration(75_000), "1m15s");
});

test("thinkingRuns groups like Pi and skips empty runs", () => {
  const runs = thinkingRuns([
    { type: "thinking", thinking: " **Plan** a " },
    { type: "thinking", thinking: "b" },
    { type: "text", text: "answer" },
    { type: "thinking", thinking: "   " },
    { type: "toolCall", name: "read" },
    { type: "thinking", thinking: "c" },
  ]);
  assert.deepEqual(runs, [
    { start: 0, end: 1, text: "**Plan** a\n\nb" },
    { start: 5, end: 5, text: "c" },
  ]);
  assert.deepEqual(thinkingRuns("nope"), []);
});

test("shimmerParts sweeps a highlight band across the text", () => {
  assert.deepEqual(shimmerParts("", 3), ["", "", ""]);
  const text = "Planning";
  for (let frame = 0; frame < 20; frame += 1) {
    assert.equal(shimmerParts(text, frame).join(""), text);
  }
  assert.deepEqual(shimmerParts(text, 3), ["", "Pla", "nning"]);
  assert.deepEqual(shimmerParts(text, 6), ["Pla", "nni", "ng"]);
});

test("spinner uses Pi's braille loader frames", () => {
  assert.equal(SPINNER_FRAMES.length, 10);
  assert.equal(SPINNER_FRAMES.at(-1), "⠏");
});
