import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, parseSessionContent } from "./audit-sessions.mjs";

test("canonicalJson mengurutkan properti objek secara alfabetis", () => {
  const obj1 = { b: 2, a: 1, nested: { y: 2, x: 1 } };
  const obj2 = { a: 1, nested: { x: 1, y: 2 }, b: 2 };
  assert.strictEqual(canonicalJson(obj1), canonicalJson(obj2));
  assert.strictEqual(
    canonicalJson(obj1),
    '{"a":1,"b":2,"nested":{"x":1,"y":2}}',
  );
});

test("parseSessionContent mendeteksi loop tool identik berturut-turut N=3 dan N=4", () => {
  // Sesi dengan:
  // - 3x toolCall bash { command: "ls" } berturut-turut -> memicu loop N=3
  // - 1x toolCall read { path: "a.txt" }
  // - 4x toolCall bash { command: "pwd" } berturut-turut -> memicu loop N=3 dan N=4
  const jsonlLines = [
    JSON.stringify({ type: "session", id: "sess-1" }),
    // Streak 1 (panjang 3)
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c2",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m3",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c3",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    }),
    // Pemutus streak
    JSON.stringify({
      type: "message",
      id: "m4",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c4",
            name: "read",
            arguments: { path: "a.txt" },
          },
        ],
      },
    }),
    // Streak 2 (panjang 4)
    JSON.stringify({
      type: "message",
      id: "m5",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c5",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m6",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c6",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m7",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c7",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m8",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c8",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
    }),
  ].join("\n");

  const result = parseSessionContent(jsonlLines, "fixture-loop.jsonl");

  assert.strictEqual(result.loopStreaks.length, 2);
  assert.strictEqual(result.loopStreaks[0].length, 3);
  assert.strictEqual(result.loopStreaks[1].length, 4);

  const n3Count = result.loopStreaks.filter((s) => s.length >= 3).length;
  const n4Count = result.loopStreaks.filter((s) => s.length >= 4).length;
  const n5Count = result.loopStreaks.filter((s) => s.length >= 5).length;

  assert.strictEqual(n3Count, 2);
  assert.strictEqual(n4Count, 1);
  assert.strictEqual(n5Count, 0);
});

test("parseSessionContent mendeteksi error tool beruntun N=3", () => {
  // Sesi dengan 3 toolResult berturut-turut bernilai isError: true
  const jsonlLines = [
    JSON.stringify({
      type: "message",
      id: "tr1",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "Command exited with code 1" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "tr2",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "Command exited with code 2" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "tr3",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "Command exited with code 127" }],
      },
    }),
    // Sukses mereset streak
    JSON.stringify({
      type: "message",
      id: "tr4",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "OK" }],
      },
    }),
  ].join("\n");

  const result = parseSessionContent(jsonlLines, "fixture-error.jsonl");

  assert.strictEqual(result.totalErrorStreaks.length, 1);
  assert.strictEqual(result.totalErrorStreaks[0], 3);
  assert.strictEqual(result.sameToolErrorStreaks.length, 1);
  assert.strictEqual(result.sameToolErrorStreaks[0].toolName, "bash");
  assert.strictEqual(result.sameToolErrorStreaks[0].length, 3);
  assert.strictEqual(result.bashExitErrorCount, 3);
});

test("parseSessionContent mendeteksi berhenti kosong setelah toolResult", () => {
  const jsonlLines = [
    JSON.stringify({
      type: "message",
      id: "tr1",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "some text" }],
      },
    }),
    // Assistant giliran terakhir kosong
    JSON.stringify({
      type: "message",
      id: "empty-asst-1",
      message: {
        role: "assistant",
        content: [{ type: "thinking", text: "hanya mikir" }],
      },
    }),
  ].join("\n");

  const result = parseSessionContent(jsonlLines, "fixture-empty-stop.jsonl");

  assert.strictEqual(result.emptyStops.length, 1);
  assert.strictEqual(result.emptyStops[0].id, "empty-asst-1");
});

test("parseSessionContent mendeteksi rincian stopReason pada Pola 2 (stop, aborted, error)", () => {
  // Tiga giliran assistant kosong setelah toolResult dengan stopReason berbeda:
  // 1. stopReason: "stop" (memiliki blok thinking) diikuti user message
  // 2. stopReason: "aborted" (tanpa thinking) diikuti user message
  // 3. stopReason: "error" di akhir sesi
  const jsonlLines = [
    // Putaran 1: stop
    JSON.stringify({
      type: "message",
      id: "tr1",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "read ok" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "asst-stop",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "sedang berpikir..." }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "user1",
      message: {
        role: "user",
        content: [{ type: "text", text: "lanjutkan" }],
      },
    }),
    // Putaran 2: aborted
    JSON.stringify({
      type: "message",
      id: "tr2",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "bash ok" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "asst-aborted",
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "user2",
      message: {
        role: "user",
        content: [{ type: "text", text: "coba lagi" }],
      },
    }),
    // Putaran 3: error (di ujung sesi)
    JSON.stringify({
      type: "message",
      id: "tr3",
      message: {
        role: "toolResult",
        toolName: "execute",
        isError: false,
        content: [{ type: "text", text: "exec ok" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "asst-error",
      message: {
        role: "assistant",
        stopReason: "error",
        content: [],
      },
    }),
  ].join("\n");

  const result = parseSessionContent(jsonlLines, "fixture-stop-reasons.jsonl");

  assert.strictEqual(result.emptyStops.length, 3);
  assert.strictEqual(result.emptyStops[0].stopReason, "stop");
  assert.strictEqual(result.emptyStops[0].hasThinkingText, true);
  assert.strictEqual(result.emptyStops[1].stopReason, "aborted");
  assert.strictEqual(result.emptyStops[1].hasThinkingText, false);
  assert.strictEqual(result.emptyStops[2].stopReason, "error");
  assert.strictEqual(result.emptyStops[2].hasThinkingText, false);
});

test("parseSessionContent melewati baris rusak tanpa crash dan menghitung skippedLines", () => {
  const jsonlLines = [
    JSON.stringify({ type: "session", id: "s1" }),
    "{ bukan json valid, rusak! }",
    "",
    "   ",
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "user",
        content: [{ type: "text", text: "halo" }],
      },
    }),
    "{ bad json line 2",
  ].join("\n");

  const result = parseSessionContent(jsonlLines, "fixture-corrupt.jsonl");

  assert.strictEqual(result.lineCount, 4);
  assert.strictEqual(result.skippedLines, 2);
  assert.strictEqual(result.messageCount, 1);
});
