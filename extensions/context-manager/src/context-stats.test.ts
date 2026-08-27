import assert from "node:assert/strict";
import test from "node:test";
import {
  createContextStats,
  formatContextStats,
  recordPrune,
  recordRetrieval,
  recordSummary,
} from "./context-stats.ts";

test("recordSummary tracks original and retained output sizes", () => {
  const stats = createContextStats();
  recordSummary(stats, "a\nb\nc\nd", "summary");

  assert.equal(stats.summarizedOutputs, 1);
  assert.equal(stats.originalChars, 7);
  assert.equal(stats.retainedChars, 7);
  assert.equal(stats.originalLines, 4);
  assert.equal(stats.retainedLines, 1);
  assert.equal(stats.estimatedOriginalTokens, 2);
  assert.equal(stats.estimatedRetainedTokens, 2);
});

test("formatContextStats reports savings and inspect usage", () => {
  const stats = createContextStats();
  recordSummary(stats, "0123456789", "short");
  stats.inspectCalls = 2;
  recordRetrieval(stats);
  recordPrune(stats, "long summary", "reference");

  const output = formatContextStats(stats);
  assert.match(output, /├─ Ukuran/);
  assert.match(
    output,
    /│  ├─ Pemrosesan: 10 karakter \(1 baris\) → 5 karakter \(1 baris\)/,
  );
  assert.match(
    output,
    /│  └─ Penghematan: 5 karakter, 0 baris \(50,0% hemat\)/,
  );
  assert.match(output, /├─ Token/);
  assert.match(output, /│  └─ Alokasi: 3 token asli → 2 token masuk context/);
  assert.match(output, /├─ Pemangkasan Output Lama/);
  assert.match(
    output,
    /│  └─ Hasil: 1 output \| 3 karakter \| 0 token dihemat/,
  );
  assert.match(output, /├─ Aktivitas/);
  assert.match(
    output,
    /│  └─ Operasi: 1 output diringkas \| 2 kali ctx_inspect \| 1 kali output cache/,
  );
  assert.match(output, /└─ Status: Normal/);
});
