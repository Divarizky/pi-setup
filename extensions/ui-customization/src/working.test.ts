import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkingMessage,
  estimateTokens,
  formatCount,
  formatDuration,
  outputUsage,
  textBlockLengths,
} from "./working.ts";

test("formatCount uses en-US grouping", () => {
  assert.equal(formatCount(1234), "1,234");
  assert.equal(formatCount(0), "0");
});

test("formatDuration formats seconds, minutes, hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(75_000), "1m15s");
  assert.equal(formatDuration(3_700_000), "1h1m");
});

test("estimateTokens uses chars/4", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(400), 100);
  assert.equal(estimateTokens(-10), 0);
});

test("textBlockLengths reads text and thinking blocks", () => {
  const lengths = textBlockLengths({
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", name: "read" },
      { type: "thinking", thinking: { text: "hmm" } },
      { type: "thinking", thinkingSignature: { body: "abcd" } },
    ],
  });
  assert.equal(lengths[0], 5);
  assert.equal(lengths[1], undefined);
  assert.equal(lengths[2], 3);
  assert.equal(lengths[3], 4);
  assert.equal(textBlockLengths({ content: "nope" }).length, 0);
  assert.equal(textBlockLengths({}).length, 0);
});

test("outputUsage prefers finite positive values", () => {
  assert.equal(outputUsage({ usage: { output: 120 } }), 120);
  assert.equal(outputUsage({ usage: { output: 0 } }), 0);
  assert.equal(outputUsage({ usage: { output: "x" } }), 0);
  assert.equal(outputUsage({}), 0);
});

test("buildWorkingMessage shows timer only after 3s", () => {
  assert.equal(buildWorkingMessage(0, 1_000), "");
  assert.equal(buildWorkingMessage(100, 1_000), "Working... (↓ 100 tokens)");
  assert.equal(
    buildWorkingMessage(1500, 12_000),
    "Working... (↓ 1,500 tokens · 12s)",
  );
  assert.equal(buildWorkingMessage(0, 5_000), "Working... (5s)");
});
