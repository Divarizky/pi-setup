import assert from "node:assert/strict";
import test from "node:test";
import { collectOutputPreview, formatOutputPreview } from "./output-preview.ts";

test("collectOutputPreview keeps bounded head and tail lines", () => {
  const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`);
  const longLine = `prefix${"x".repeat(600)}tail`;
  const preview = collectOutputPreview(`${lines.join("\r\n")}\r\n${longLine}\r\n`);

  assert.equal(preview.totalLines, 51);
  assert.deepEqual(preview.head.slice(0, 2), ["line-1", "line-2"]);
  assert.equal(preview.head.length, 20);
  assert.equal(preview.tail.length, 20);
  assert.equal(preview.tail.at(-1)?.length, 500);
  assert.ok(preview.tail.at(-1)?.startsWith("…"));
  assert.ok(preview.tail.at(-1)?.endsWith("tail"));

  const collapsed = formatOutputPreview(preview, 8);
  assert.deepEqual(collapsed.slice(0, 4), ["line-1", "line-2", "line-3", "line-4"]);
  assert.equal(collapsed[4], "… +43 lines omitted");
  assert.deepEqual(collapsed.slice(-3), ["line-49", "line-50", preview.tail.at(-1)]);

  const expanded = formatOutputPreview(preview, 40);
  assert.equal(expanded.length, 41);
  assert.equal(expanded[20], "… +11 lines omitted");
  assert.equal(expanded.at(-1), preview.tail.at(-1));
});

test("collectOutputPreview replaces carriage-return progress lines", () => {
  const preview = collectOutputPreview("progress 10%\rprogress 40%\rprogress 100%\nnext line");
  assert.deepEqual(formatOutputPreview(preview, 8), ["progress 100%", "next line"]);
});

test("collectOutputPreview sanitizes terminal controls and marks empty output", () => {
  const preview = collectOutputPreview("\u001b[31mred\u001b[0m\nsecond");
  assert.deepEqual(preview.head, ["red", "second"]);
  assert.deepEqual(formatOutputPreview(collectOutputPreview(""), 8), ["(no output)"]);
});

test("collectOutputPreview strips C1 terminal controls", () => {
  const preview = collectOutputPreview("\u009d52;c;secret\u0007hello\u009b31mred\u009c");
  assert.deepEqual(preview.head, ["52;c;secrethello31mred"]);
  assert.doesNotMatch(preview.head.join(""), /[\u007f-\u009f]/);
});
