import assert from "node:assert/strict";
import test from "node:test";
import { SUMMARY_SYSTEM_PROMPT } from "./src/prompt.ts";
import { parseRecapResponse, reasoningOptions } from "./src/summarizer.ts";

test("requires durable recap fields to be written in Bahasa Indonesia", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /durable.*recap.*next.*Bahasa Indonesia/s);
});

test("omits reasoning when configured off", () => {
  assert.deepEqual(reasoningOptions("off"), {});
  assert.deepEqual(reasoningOptions("medium"), { reasoning: "medium" });
});

test("parses strict durable recap JSON", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"durable":true,"recap":"Updated config and ran focused tests.","next":"Review the diff."}',
    ),
    {
      durable: true,
      recap: "Updated config and ran focused tests.",
      next: "Review the diff.",
    },
  );
});

test("defensively extracts fenced JSON and normalizes Next", () => {
  assert.deepEqual(
    parseRecapResponse(
      'Result follows:\n```json\n{"durable":true,"recap":"- Added the extension\\n- Tests pass","next":"Next: Reload Pi."}\n```',
    ),
    {
      durable: true,
      recap: "- Added the extension\n- Tests pass",
      next: "Reload Pi.",
    },
  );
});

test("accepts non-durable runs with an empty recap", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"durable":false,"recap":"","next":"No further action is required."}',
    ),
    {
      durable: false,
      recap: "",
      next: "No further action is required.",
    },
  );
});

test("rejects malformed or incomplete output", () => {
  assert.throws(() => parseRecapResponse("not json"), /valid recap JSON/);
  assert.throws(
    () => parseRecapResponse('{"durable":true,"recap":"missing next"}'),
    /valid recap JSON/,
  );
  assert.throws(
    () =>
      parseRecapResponse(
        '{"durable":true,"recap":"done","next":"nothing","extra":"not allowed"}',
      ),
    /valid recap JSON/,
  );
});

test("strips terminal control sequences from recap fields", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"durable":true,"recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Review it.\\u0007"}',
    ),
    { durable: true, recap: "Updated config.", next: "Review it." },
  );
});
