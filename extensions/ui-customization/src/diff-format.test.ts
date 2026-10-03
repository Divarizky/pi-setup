import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLineDiff,
  changedBlocks,
  contentRows,
  describeBlocks,
  diffRowStats,
  inlineSpans,
  meterSplit,
  pairChangedRows,
  parseDisplayDiff,
  serializeDisplayDiff,
} from "./diff-format.ts";

// Pi's edit diff: context lines carry old-file numbers.
const PI_DIFF = [
  "  1 const a = 1;",
  "- 2 return a;",
  "+ 2 const b = a;",
  "+ 3 return b;",
  "  3 }",
  "    ...",
  "  9 x();",
  "-10 y();",
  " 11 z();",
].join("\n");

test("parseDisplayDiff derives new-file numbers", () => {
  const rows = parseDisplayDiff(PI_DIFF);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldNo, row.newNo, row.at]),
    [
      ["context", 1, 1, undefined],
      ["remove", 2, undefined, 2],
      ["add", undefined, 2, undefined],
      ["add", undefined, 3, undefined],
      ["context", 3, 4, undefined],
      ["gap", undefined, undefined, undefined],
      ["context", 9, 10, undefined],
      ["remove", 10, undefined, 11],
      ["context", 11, 11, undefined],
    ],
  );
  assert.equal(parseDisplayDiff("+ 1 \tx").at(0)?.text, "  x");
});

test("changedBlocks and describeBlocks spell out line ranges", () => {
  const rows = parseDisplayDiff(PI_DIFF);
  assert.deepEqual(diffRowStats(rows), { added: 2, removed: 2 });
  const blocks = changedBlocks(rows);
  assert.deepEqual(blocks, [
    { start: 2, end: 3 },
    { start: 11, end: 11 },
  ]);
  assert.equal(describeBlocks(blocks, 80), "2 changed blocks: lines 2–3 and line 11");
  assert.equal(describeBlocks(blocks.slice(0, 1), 80), "1 changed block: lines 2–3");
  // The full text is 39 characters, so 38 forces the shortened list.
  assert.equal(describeBlocks(blocks, 38), "2 changed blocks: lines 2–3 and 1 more");
  assert.equal(describeBlocks(blocks, 17), "2 changed blocks");
  assert.equal(describeBlocks(blocks, 5), "");
  const many = [1, 5, 9, 13].map((n) => ({ start: n, end: n }));
  assert.equal(describeBlocks(many, 80), "4 changed blocks: line 1, line 5, line 9 and line 13");
});

test("buildLineDiff matches Pi's layout and round-trips", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const after = before.replace("l3\n", "L3\n").replace("l18\n", "");
  const rows = buildLineDiff(before, after, 2)!;
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.oldNo ?? ""}/${row.newNo ?? ""}`),
    [
      "context:1/1",
      "context:2/2",
      "remove:3/",
      "add:/3",
      "context:4/4",
      "context:5/5",
      "gap:/",
      "context:16/16",
      "context:17/17",
      "remove:18/",
      "context:19/18",
      "context:20/19",
    ],
  );
  const reparsed = parseDisplayDiff(serializeDisplayDiff(rows));
  assert.deepEqual(reparsed, rows);
  assert.deepEqual(changedBlocks(rows), [
    { start: 3, end: 3 },
    { start: 18, end: 18 },
  ]);
  assert.deepEqual(buildLineDiff("a\r\nb\r\n", "a\nb\n"), []);
});

test("buildLineDiff gives up on huge rewrites", () => {
  const big = (prefix: string) => Array.from({ length: 2_500 }, (_, i) => `${prefix}${i}`).join("\n");
  assert.equal(buildLineDiff(big("a"), big("b")), undefined);
});

test("contentRows numbers every line of a new file", () => {
  assert.deepEqual(
    contentRows("x\ny\n").map((row) => [row.kind, row.newNo, row.text]),
    [
      ["add", 1, "x"],
      ["add", 2, "y"],
    ],
  );
});

test("meterSplit keeps both sides visible", () => {
  assert.deepEqual(meterSplit(16, { added: 2, removed: 1 }), { added: 11, removed: 5 });
  assert.deepEqual(meterSplit(16, { added: 100, removed: 1 }), { added: 15, removed: 1 });
  assert.deepEqual(meterSplit(16, { added: 1, removed: 100 }), { added: 1, removed: 15 });
  assert.deepEqual(meterSplit(16, { added: 24, removed: 0 }), { added: 16, removed: 0 });
});

test("pairChangedRows and inlineSpans mark the changed words", () => {
  const rows = parseDisplayDiff(PI_DIFF);
  const pairs = pairChangedRows(rows);
  assert.equal(pairs.get(rows[1]!), rows[2]);
  assert.equal(pairs.get(rows[3]!), undefined);
  assert.equal(pairs.get(rows[7]!), undefined);

  const spans = inlineSpans("  return render(user);", "  const view = render(user);");
  assert.deepEqual(spans.old, [{ start: 2, end: 8 }]);
  assert.deepEqual(spans.new, [{ start: 2, end: 14 }]);
  assert.deepEqual(inlineSpans("abc", "xyz"), { old: [], new: [] });
});
