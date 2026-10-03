import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLine,
  countIssues,
  formatBashDuration,
  lastNonEmptyLine,
  numberedTail,
  outputLines,
  parseBashResult,
  splitReadNotice,
} from "./bash-format.ts";

test("numberedTail numbers lines by their position in the full output", () => {
  assert.deepEqual(numberedTail(["a", "b", "c"], 3, 2), {
    hidden: 1,
    rows: [{ no: 2, text: "b" }, { no: 3, text: "c" }],
  });
  // Pi kept only the last 2 of 50 lines.
  assert.deepEqual(numberedTail(["y", "z"], 50, 20), {
    hidden: 48,
    rows: [{ no: 49, text: "y" }, { no: 50, text: "z" }],
  });
  assert.deepEqual(numberedTail([], 0, 20), { hidden: 0, rows: [] });
});

test("splitReadNotice separates the continuation notice from file content", () => {
  assert.deepEqual(splitReadNotice("a\nb\n"), { content: "a\nb", notice: undefined });
  assert.deepEqual(
    splitReadNotice("a\nb\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]"),
    { content: "a\nb", notice: "Showing lines 1-2 of 9. Use offset=3 to continue." },
  );
  assert.deepEqual(
    splitReadNotice("a\n\n[7 more lines in file. Use offset=2 to continue.]"),
    { content: "a", notice: "7 more lines in file. Use offset=2 to continue." },
  );
});

test("parseBashResult strips Pi's status and truncation notices", () => {
  assert.deepEqual(parseBashResult("ok\n", false), { output: "ok", exitCode: 0, failure: undefined });
  assert.deepEqual(parseBashResult("boom\n\nCommand exited with code 3", true), {
    output: "boom",
    exitCode: 3,
    failure: undefined,
  });
  assert.deepEqual(parseBashResult("x\n\nCommand timed out after 30 seconds", true), {
    output: "x",
    exitCode: undefined,
    failure: "timed out after 30s",
  });
  assert.equal(parseBashResult("Command aborted", true).failure, "aborted");
  assert.equal(parseBashResult("(no output)", false).output, "");
  assert.equal(
    parseBashResult(
      "a\nb\n\n[Showing lines 3-4 of 4. Full output: C:\\tmp\\pi.log]\n\nCommand exited with code 1",
      true,
    ).output,
    "a\nb",
  );
});

test("classifyLine flags errors and warnings but not zero counts", () => {
  assert.equal(classifyLine("src/a.ts:12  error  'x' is unused"), "error");
  assert.equal(classifyLine("ℹ fail 1"), "error");
  assert.equal(classifyLine("npm ERR! code 1"), "error");
  assert.equal(classifyLine("src/b.ts:40  warn  prefer const"), "warning");
  assert.equal(classifyLine("ℹ fail 0"), undefined);
  assert.equal(classifyLine("Found 0 errors."), undefined);
  assert.equal(classifyLine("no warnings"), undefined);
  assert.equal(classifyLine("compiled successfully"), undefined);
  assert.deepEqual(countIssues(["error a", "warning b", "ok", "error c"]), { errors: 2, warnings: 1 });
});

test("formatBashDuration and line helpers", () => {
  assert.equal(formatBashDuration(200), "0.2s");
  assert.equal(formatBashDuration(12_400), "12.4s");
  assert.equal(formatBashDuration(65_000), "1m5s");
  assert.deepEqual(outputLines(""), []);
  assert.deepEqual(outputLines("a\r\nb"), ["a", "b"]);
  assert.equal(lastNonEmptyLine(["a", "b", "  ", ""]), "b");
});
