import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  callTitle,
  clip,
  countLines,
  diffStats,
  expandControl,
  previewLines,
  resultSummary,
  shortenPath,
  tailLines,
} from "./tool-format.ts";

const home = join("C:", "Users", "me");
const cwd = join(home, "project");

test("clip collapses whitespace and adds ellipsis", () => {
  assert.equal(clip("a\n  b"), "a b");
  const clipped = clip("x".repeat(100), 10);
  assert.equal([...clipped].length, 10);
  assert.ok(clipped.endsWith("…"));
});

test("shortenPath prefers cwd-relative, then home", () => {
  assert.equal(shortenPath(join(cwd, "src", "a.ts"), cwd, home), "src/a.ts");
  assert.equal(shortenPath(join(home, "notes.md"), cwd, home), "~/notes.md");
  assert.equal(shortenPath("src\\b.ts", cwd, home), "src/b.ts");
  assert.equal(shortenPath("", cwd, home), "");
});

test("callTitle uses Pi's built-in tool names", () => {
  assert.deepEqual(callTitle("read", { path: "a.ts", offset: 10, limit: 5 }, cwd, home), {
    label: "read",
    arg: "a.ts:10-14",
  });
  assert.deepEqual(callTitle("bash", { command: "npm   test" }, cwd, home), {
    label: "bash",
    arg: "npm test",
  });
  assert.equal(callTitle("edit", { path: "a.ts" }, cwd, home).label, "edit");
  assert.equal(callTitle("write", { path: "a.ts" }, cwd, home).label, "write");
});

test("countLines ignores one trailing newline", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a"), 1);
});

test("diffStats counts Pi display diff lines", () => {
  assert.deepEqual(diffStats(" 1 same\n-2 old\n+2 new\n+3 more\n    ..."), {
    added: 2,
    removed: 1,
  });
});

test("resultSummary per tool", () => {
  assert.equal(resultSummary({ toolName: "read", text: "a\nb\nc", isError: false }), "Read 3 lines");
  assert.equal(
    resultSummary({ toolName: "read", text: "a", isError: false, truncatedFrom: 5000 }),
    "Read 1 line (truncated from 5000)",
  );
  assert.equal(resultSummary({ toolName: "bash", text: "  \n", isError: false }), "(No output)");
  assert.equal(
    resultSummary({ toolName: "edit", text: "", isError: false, diff: "-1 a\n+1 b\n+2 c" }),
    "Added 2 lines, removed 1 line",
  );
  assert.equal(
    resultSummary({ toolName: "write", text: "", isError: false, writeContent: "a\nb" }),
    "Wrote 2 lines",
  );
  assert.equal(
    resultSummary({ toolName: "read", text: "\nboom: failed\nmore", isError: true }),
    "boom: failed",
  );
  assert.equal(
    resultSummary({ toolName: "bash", text: "nope\n\nCommand exited with code 3", isError: true }),
    "Error: exit code 3",
  );
  assert.equal(
    resultSummary({ toolName: "bash", text: "Command timed out after 5 seconds", isError: true }),
    "Error: command timed out after 5 seconds",
  );
});

test("tailLines keeps the newest streamed lines", () => {
  assert.deepEqual(tailLines("", 2), { lines: [], hidden: 0 });
  assert.deepEqual(tailLines("a\nb\nc\nd\n", 2), { lines: ["c", "d"], hidden: 2 });
});

test("expandControl is a button in fullscreen and a key hint in regular", () => {
  assert.deepEqual(expandControl("fullscreen", false, "ctrl+o"), { text: "click to expand", button: true });
  assert.deepEqual(expandControl("fullscreen", true, "ctrl+o"), { text: "click to collapse", button: true });
  assert.deepEqual(expandControl("regular", false, "alt+e"), { text: "(alt+e to expand)", button: false });
  assert.equal(expandControl("regular", true, "ctrl+o"), undefined);
  assert.equal(expandControl("regular", false, "")?.text, "(ctrl+o to expand)");
});

test("previewLines caps and reports hidden lines", () => {
  assert.deepEqual(previewLines("", 3), { lines: [], hidden: 0 });
  assert.deepEqual(previewLines("a\nb\n", 3), { lines: ["a", "b"], hidden: 0 });
  assert.deepEqual(previewLines("a\nb\nc\nd", 2), { lines: ["a", "b"], hidden: 2 });
});
