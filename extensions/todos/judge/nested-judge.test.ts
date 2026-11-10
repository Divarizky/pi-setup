import assert from "node:assert/strict";
import test from "node:test";
import { parseVerdict, runNestedJudge } from "./nested-judge.ts";

const INPUT = {
  editedPaths: ["src/a.ts"],
  validationCommands: [],
  lastAssistantText: "selesai",
};

test("verdict tidak_terverifikasi dari JSON model dibaca dengan benar", () => {
  const result = parseVerdict('{"verdict":"tidak_terverifikasi","reason":"tidak ada test"}');
  assert.equal(result.verdict, "tidak_terverifikasi");
  assert.equal(result.reason, "tidak ada test");
});

test("JSON di dalam teks bebas tetap dikenali", () => {
  const result = parseVerdict('Hasil: {"verdict":"terverifikasi"} selesai.');
  assert.equal(result.verdict, "terverifikasi");
});

test("output model yang bukan JSON menjadi tidak_diketahui, bukan terverifikasi", () => {
  assert.equal(parseVerdict("saya rasa sudah aman").verdict, "tidak_diketahui");
  assert.equal(parseVerdict('{"verdict":"ya"}').verdict, "tidak_diketahui");
});

test("model melempar error menghasilkan tidak_diketahui tanpa melempar ke pemanggil", async () => {
  const result = await runNestedJudge(INPUT, async () => {
    throw new Error("upstream 429");
  }, 1000);
  assert.equal(result.verdict, "tidak_diketahui");
  assert.equal(result.reason, "upstream 429");
});

test("stopReason error dari provider tetap fail-open", async () => {
  const result = await runNestedJudge(INPUT, async () => ({
    stopReason: "error",
    content: [],
  }), 1000);
  assert.equal(result.verdict, "tidak_diketahui");
});

test("judge yang melewati batas waktu dibatalkan dan tidak menggantung", async () => {
  const result = await runNestedJudge(INPUT, (_prompt, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }), 20);
  assert.equal(result.verdict, "tidak_diketahui");
});

test("respons valid dari model diteruskan sebagai verdict", async () => {
  const result = await runNestedJudge(INPUT, async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: '{"verdict":"terverifikasi","reason":"build lulus"}' }],
  }), 1000);
  assert.equal(result.verdict, "terverifikasi");
});

test("timeout ditandai timedOut=true dan tidak menggantung", async () => {
  const result = await runNestedJudge(INPUT, (_p, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }), 20);
  assert.equal(result.verdict, "tidak_diketahui");
  assert.equal(result.timedOut, true);
});

test("pembatalan sesi membatalkan judge dan timedOut tetap false", async () => {
  const session = new AbortController();
  const pending = runNestedJudge(INPUT, (_p, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }), 60000, session.signal);
  session.abort();
  const result = await pending;
  assert.equal(result.verdict, "tidak_diketahui");
  assert.equal(result.timedOut, false);
});

test("sinyal sesi yang sudah berhenti sebelum judge dimulai langsung membatalkan", async () => {
  const session = new AbortController();
  session.abort();
  let receivedAborted = false;
  const result = await runNestedJudge(INPUT, async (_p, signal) => {
    receivedAborted = signal?.aborted === true;
    return { stopReason: "aborted", content: [] };
  }, 60000, session.signal);
  assert.equal(receivedAborted, true);
  assert.equal(result.verdict, "tidak_diketahui");
});

test("elapsedMs memakai jam yang disuntikkan dan mencatat durasi panggilan", async () => {
  let t = 1000;
  const clock = () => t;
  const result = await runNestedJudge(INPUT, async () => {
    t += 1234;
    return { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"terverifikasi"}' }] };
  }, 60000, undefined, clock);
  assert.equal(result.elapsedMs, 1234);
  assert.equal(result.verdict, "terverifikasi");
  assert.equal(result.timedOut, false);
});

test("complete yang mengabaikan signal tetap dipaksa berhenti oleh batas waktu", async () => {
  const started = Date.now();
  const result = await runNestedJudge(INPUT, () => new Promise(() => {}), 30);
  assert.equal(result.verdict, "tidak_diketahui");
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2000, "tidak boleh menggantung");
});
