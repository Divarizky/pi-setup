import assert from "node:assert/strict";
import test from "node:test";
import { classifyLine, inspectBlocks, previewRows, renderFrameRows } from "./output-frame.ts";

const plain = { fg: (_color: string, text: string) => text };

test("previewRows numbers head and tail by position in the full output", () => {
  const preview = {
    head: Array.from({ length: 20 }, (_, index) => `line-${index + 1}`),
    tail: Array.from({ length: 20 }, (_, index) => `line-${index + 81}`),
    totalLines: 100,
  };
  const rows = previewRows(preview, 4);
  assert.deepEqual(rows, [
    { kind: "line", no: 1, text: "line-1", tone: undefined },
    { kind: "line", no: 2, text: "line-2", tone: undefined },
    { kind: "gap", label: "+96 lines omitted" },
    { kind: "line", no: 99, text: "line-99", tone: undefined },
    { kind: "line", no: 100, text: "line-100", tone: undefined },
  ]);
  assert.deepEqual(previewRows({ head: ["a", "b"], tail: [], totalLines: 2 }, 20).map((row) => row.kind === "line" && row.no), [1, 2]);
  assert.deepEqual(previewRows({ head: [], tail: [], totalLines: 0 }, 20), []);
});

test("classifyLine ignores zero counts", () => {
  assert.equal(classifyLine("src/a.ts(4,1): error TS2304"), "error");
  assert.equal(classifyLine("npm WARN deprecated"), "warning");
  assert.equal(classifyLine("Found 0 errors"), undefined);
});

test("inspectBlocks groups numbered snippets and marks query hits", () => {
  const raw = [
    "Snippet untuk \"boom\":",
    "---",
    "3: before",
    "4: boom here",
    "---",
    "9: boom again",
  ].join("\n");
  const blocks = inspectBlocks(raw, "boom");
  assert.equal(blocks[0]?.kind, "text");
  assert.equal(blocks[1]?.kind, "rows");
  const rows = blocks[1]?.kind === "rows" ? blocks[1].rows : [];
  assert.deepEqual(rows, [
    { kind: "line", no: 3, text: "before", tone: undefined },
    { kind: "line", no: 4, text: "boom here", tone: "hit" },
    { kind: "gap", label: "" },
    { kind: "line", no: 9, text: "boom again", tone: "hit" },
  ]);
});

test("renderFrameRows frames numbered rows without exceeding the width", () => {
  const lines = renderFrameRows(
    [
      { kind: "gap", label: "8 earlier lines" },
      { kind: "line", no: 9, text: "x".repeat(200), tone: "error" },
      { kind: "line", no: 10, text: "ok" },
    ],
    40,
    plain,
  );
  assert.match(lines[0]!, /^ {5}─+$/);
  assert.match(lines[1]!, /⋮ │ 8 earlier lines/);
  assert.match(lines[2]!, /▌  9 │ x+…/);
  assert.match(lines[3]!, /10 │ ok/);
  for (const line of lines) assert.ok([...line].length <= 40, line);
});
