import assert from "node:assert/strict";
import test from "node:test";
import {
  computeStats,
  parseLog,
  selectEvaluated,
} from "./task-judge-fp.mjs";

const SINCE = "2026-10-28T08:45:00.000Z";

test("run sebelum waktu cutoff dan run dikecualikan tidak ikut dihitung", () => {
  const entries = [
    { timestamp: "2026-10-28T08:44:00.000Z", decision: "tidak_terverifikasi" },
    { timestamp: "2026-10-28T09:00:00.000Z", decision: "dikecualikan" },
    { timestamp: "2026-10-28T09:01:00.000Z", decision: "tidak_terverifikasi" },
  ];
  const selected = selectEvaluated(entries, SINCE);
  assert.deepEqual(
    selected.map((e) => e.timestamp),
    ["2026-10-28T09:01:00.000Z"],
  );
});

test("false positive rate dihitung hanya dari peringatan yang sudah dilabeli", () => {
  const evaluated = [
    { timestamp: "t1", decision: "tidak_terverifikasi" },
    { timestamp: "t2", decision: "tidak_terverifikasi" },
    { timestamp: "t3", decision: "tidak_terverifikasi" },
    { timestamp: "t4", decision: "terverifikasi" },
  ];
  const labels = [
    { timestamp: "t1", real: false },
    { timestamp: "t2", real: true },
  ];
  const stats = computeStats(evaluated, labels);
  assert.equal(stats.warnings, 3);
  assert.equal(stats.labeled, 2);
  assert.equal(stats.unlabeled, 1);
  assert.equal(stats.falsePositives, 1);
  assert.equal(stats.fpRate, 0.5);
});

test("tanpa label, fpRate null dan bukan 0", () => {
  const stats = computeStats([
    { timestamp: "t1", decision: "tidak_terverifikasi" },
  ]);
  assert.equal(stats.fpRate, null);
});

test("baris log rusak dilewati tanpa menggagalkan parsing", () => {
  const { entries, skipped } = parseLog('{"timestamp":"a"}\nnot-json\n\n');
  assert.equal(entries.length, 1);
  assert.equal(skipped, 1);
});
