import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  DEFAULT_CONFIG,
  claimContinuation,
  createFailureState,
  isEmptyStop,
  parseConfig,
  registerToolCall,
  registerToolResult,
  renderTemplate,
} from "./detectors.ts";

test("pemanggilan identik ke-3 berturut-turut diblokir, yang berbeda tidak", () => {
  const state = createFailureState();
  const input = { path: "a.ts" };
  assert.equal(registerToolCall(state, "read", input, 3), false);
  assert.equal(registerToolCall(state, "read", input, 3), false);
  assert.equal(registerToolCall(state, "read", input, 3), true);

  const fresh = createFailureState();
  registerToolCall(fresh, "read", { path: "a.ts" }, 3);
  registerToolCall(fresh, "read", { path: "b.ts" }, 3);
  assert.equal(registerToolCall(fresh, "read", { path: "a.ts" }, 3), false);
});

test("argumen dengan urutan kunci berbeda dianggap identik", () => {
  const state = createFailureState();
  registerToolCall(state, "edit", { path: "x", old: "1" }, 3);
  registerToolCall(state, "edit", { old: "1", path: "x" }, 3);
  assert.equal(registerToolCall(state, "edit", { path: "x", old: "1" }, 3), true);
});

test("canonicalJson menghasilkan string sama untuk objek bersarang dengan urutan kunci berbeda", () => {
  assert.equal(
    canonicalJson({ b: { y: 1, x: [2] }, a: null }),
    canonicalJson({ a: null, b: { x: [2], y: 1 } }),
  );
});

test("error beruntun dianotasi tepat pada ambang, dan reset oleh sukses", () => {
  const state = createFailureState();
  assert.equal(registerToolResult(state, true, 3), false);
  assert.equal(registerToolResult(state, true, 3), false);
  assert.equal(registerToolResult(state, true, 3), true);
  assert.equal(registerToolResult(state, false, 3), false);
  assert.equal(registerToolResult(state, true, 3), false);
});

const assistantEmpty = {
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "   " }],
};

test("berhenti kosong terdeteksi setelah toolResult dengan stopReason stop", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "tugas" }] },
    { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    assistantEmpty,
  ];
  assert.equal(isEmptyStop(messages), true);
});

test("respons yang memuat toolCall atau teks tidak dianggap berhenti kosong", () => {
  const withTool = [
    { role: "toolResult", content: [] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "toolCall", name: "read", arguments: {} }],
    },
  ];
  const withText = [
    { role: "toolResult", content: [] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "selesai" }],
    },
  ];
  assert.equal(isEmptyStop(withTool), false);
  assert.equal(isEmptyStop(withText), false);
});

test("stopReason selain stop tidak memicu continuation", () => {
  const messages = [
    { role: "toolResult", content: [] },
    { role: "assistant", stopReason: "length", content: [] },
  ];
  assert.equal(isEmptyStop(messages), false);
});

test("continuation berhenti tepat pada batas maxRetries per run", () => {
  const state = createFailureState();
  assert.equal(claimContinuation(state, 3), true);
  assert.equal(claimContinuation(state, 3), true);
  assert.equal(claimContinuation(state, 3), true);
  assert.equal(claimContinuation(state, 3), false);
});

test("konfigurasi tidak valid kembali ke default, bukan mematikan detektor", () => {
  const config = parseConfig({
    loop: { enabled: "ya", threshold: 1 },
    consecutiveErrors: { threshold: 2.5 },
    emptyStop: { enabled: false },
  });
  assert.equal(config.loop.enabled, true);
  assert.equal(config.loop.threshold, 5);
  assert.equal(config.consecutiveErrors.threshold, 3);
  assert.equal(config.emptyStop.enabled, false);
});

test("placeholder template yang tidak dikenal tetap utuh", () => {
  assert.equal(
    renderTemplate("Gagal {count} kali pada {tool}", { count: "3" }),
    "Gagal 3 kali pada {tool}",
  );
});

test("default loop 5: panggilan identik ke-4 belum diblokir, ke-5 diblokir", () => {
  const state = createFailureState();
  const threshold = DEFAULT_CONFIG.loop.threshold;
  for (let i = 1; i < threshold; i++) {
    assert.equal(registerToolCall(state, "bash", { command: "ls" }, threshold), false);
  }
  assert.equal(registerToolCall(state, "bash", { command: "ls" }, threshold), true);
});
