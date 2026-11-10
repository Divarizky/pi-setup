import test from "node:test";
import assert from "node:assert/strict";
import {
  parseConflictMarkers,
  applyConflictResolutions,
} from "./core.ts";

test("parseConflictMarkers: mendeteksi blok konflik git standar 2-way", () => {
  const content = [
    "function start() {",
    "<<<<<<< HEAD",
    "  const branch = 'ours';",
    "=======",
    "  const branch = 'theirs';",
    ">>>>>>> feat/new-feature",
    "  return branch;",
    "}",
  ].join("\n");

  const parsed = parseConflictMarkers(content);
  assert.equal(parsed.hasConflicts, true);
  assert.equal(parsed.hunks.length, 1);
  assert.deepEqual(parsed.hunks[0].ours, ["  const branch = 'ours';"]);
  assert.deepEqual(parsed.hunks[0].theirs, ["  const branch = 'theirs';"]);
  assert.equal(parsed.hunks[0].base, undefined);
});

test("parseConflictMarkers: mendeteksi blok konflik git diff3 (dengan base)", () => {
  const content = [
    "<<<<<<< HEAD",
    "  const val = 1;",
    "||||||| base-commit",
    "  const val = 0;",
    "=======",
    "  const val = 2;",
    ">>>>>>> feat/diff3",
  ].join("\n");

  const parsed = parseConflictMarkers(content);
  assert.equal(parsed.hasConflicts, true);
  assert.equal(parsed.hunks.length, 1);
  assert.deepEqual(parsed.hunks[0].ours, ["  const val = 1;"]);
  assert.deepEqual(parsed.hunks[0].base, ["  const val = 0;"]);
  assert.deepEqual(parsed.hunks[0].theirs, ["  const val = 2;"]);
});

test("applyConflictResolutions: resolusi 'theirs' menggantikan konflik dengan sukses", () => {
  const content = [
    "function start() {",
    "<<<<<<< HEAD",
    "  const branch = 'ours';",
    "=======",
    "  const branch = 'theirs';",
    ">>>>>>> feat/new-feature",
    "  return branch;",
    "}",
  ].join("\n");

  const res = applyConflictResolutions(content, [{ hunkId: 1, choice: "theirs" }]);
  assert.equal(res.success, true);
  assert.equal(res.remainingConflicts, 0);
  assert.match(res.resolvedContent, /const branch = 'theirs';/);
  assert.ok(!res.resolvedContent.includes("<<<<<<<"));
  assert.ok(!res.resolvedContent.includes("const branch = 'ours';"));
});

test("applyConflictResolutions: resolusi 'custom' menyuntikkan teks manual", () => {
  const content = [
    "<<<<<<< HEAD",
    "line-a",
    "=======",
    "line-b",
    ">>>>>>> branch",
  ].join("\n");

  const res = applyConflictResolutions(content, [
    { hunkId: 1, choice: "custom", customContent: "line-custom-merged" },
  ]);

  assert.equal(res.success, true);
  assert.equal(res.remainingConflicts, 0);
  assert.equal(res.resolvedContent.trim(), "line-custom-merged");
});
