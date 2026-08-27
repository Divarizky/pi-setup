import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyComposer,
  linesFromRead,
  typeAndSubmit,
} from "../src/transports/composer.ts";

test("composer classifier reads bordered boxes only when a prompt row exists", () => {
  assert.equal(
    classifyComposer([
      "╭─────────────────╮",
      "│ >               │",
      "╰── Composer ─────╯",
    ]),
    "empty",
  );

  assert.equal(
    classifyComposer([
      "╭─────────────────╮",
      "│ > hello captain │",
      "╰─────────────────╯",
    ]),
    "pending",
  );

  // Popup placeholder fill still counts as pending, not submitted.
  assert.equal(
    classifyComposer([
      "  ╭──────────────────────────────────────╮",
      "  │ ❯ /compact compaction instructions   │",
      "  ╰──────────────── Composer ────────────╯",
      "",
      "  Enter:send",
    ]),
    "pending",
  );

  // A stale startup banner must never classify as an empty composer.
  assert.equal(
    classifyComposer([
      "╭────────────────────────╮",
      "│ permissions: YOLO mode │",
      "╰────────────────────────╯",
      "› Use /skills to list available skills",
    ]),
    "unknown",
  );
});

test("composer classifier reads borderless prompt rows and refuses everything else", () => {
  assert.equal(
    classifyComposer(["────────────────", "❯", "────────────────"]),
    "empty",
  );
  assert.equal(
    classifyComposer(["some earlier output", "❯ hello there"]),
    "pending",
  );

  // A bare dead-shell prompt is not a safe injection target.
  assert.equal(
    classifyComposer(["some earlier output", "kunchen@mac firstmate $"]),
    "unknown",
  );
  assert.equal(classifyComposer([]), "unknown");
  assert.equal(
    classifyComposer(["random agent output with no composer"]),
    "unknown",
  );
});

test("linesFromRead extracts rows from every documented read shape", () => {
  assert.deepEqual(linesFromRead({ terminal: { tail: ["a", "b"] } }), [
    "a",
    "b",
  ]);
  assert.deepEqual(linesFromRead({ lines: ["x"] }), ["x"]);
  assert.deepEqual(linesFromRead({ text: "one\ntwo" }), ["one", "two"]);
  assert.deepEqual(linesFromRead({}), []);
});

test("typeAndSubmit types once and retries Enter while pending", async () => {
  const calls: string[] = [];
  let reads = 0;
  const io = {
    readTail: async () => {
      reads++;
      // First check: our typed text still sits in the composer. Second: cleared.
      return { lines: [reads === 1 ? "❯ queued message" : "❯"] };
    },
    type: async (text: string) => {
      calls.push(`type:${text}`);
    },
    submit: async () => {
      calls.push("submit");
    },
  };
  const result = await typeAndSubmit(io, "hello", { delayMs: 0 });
  assert.equal(result, "submitted");
  assert.deepEqual(calls, ["type:hello", "submit"]);
});

test("typeAndSubmit refuses to claim success when the composer stays pending", async () => {
  const calls: string[] = [];
  const io = {
    readTail: async () => ({ lines: ["❯ still pending"] }),
    type: async (text: string) => {
      calls.push(`type:${text}`);
    },
    submit: async () => {
      calls.push("submit");
    },
  };
  const result = await typeAndSubmit(io, "hello", { attempts: 2, delayMs: 0 });
  assert.equal(result, "pending-composer");
  assert.deepEqual(calls, ["type:hello", "submit", "submit"]);
});

test("typeAndSubmit refuses to submit when the composer is unidentifiable", async () => {
  const calls: string[] = [];
  const io = {
    readTail: async () => ({ lines: ["kunchen@mac firstmate $"] }),
    type: async (text: string) => {
      calls.push(`type:${text}`);
    },
    submit: async () => {
      calls.push("submit");
    },
  };
  const result = await typeAndSubmit(io, "hello", { attempts: 1 });
  assert.equal(result, "unknown-composer");
  assert.deepEqual(calls, ["type:hello"]);
});
