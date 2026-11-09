import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePruneKeepLimit,
  formatContextPercent,
  isLooseContextWindow,
  LARGE_CONTEXT_WINDOW_THRESHOLD,
  MODERATE_CONTEXT_THRESHOLD,
  selectCompressionMode,
} from "./context-policy.ts";

test("selectCompressionMode preserves detail below 30 percent", () => {
  assert.equal(selectCompressionMode(29.9), "preserve");
});

test("selectCompressionMode uses moderate compression from 30 through 60 percent", () => {
  assert.equal(selectCompressionMode(30), "moderate");
  assert.equal(selectCompressionMode(60), "moderate");
});

test("selectCompressionMode uses compact mode above 60 percent", () => {
  assert.equal(selectCompressionMode(60.1), "compact");
  assert.equal(selectCompressionMode(undefined), "moderate");
});

test("selectCompressionMode stops preserving once absolute tokens are large", () => {
  assert.equal(selectCompressionMode(10, 5_000), "preserve");
  // 10% dari window 1M tetap 100k token yang ditagih penuh.
  assert.equal(selectCompressionMode(10, 100_000), "moderate");
});

test("formatContextPercent handles known and unknown usage", () => {
  assert.equal(formatContextPercent(62.4), "62%");
  assert.equal(formatContextPercent(null), "tidak diketahui");
});

test("isLooseContextWindow identifies large context windows with low utilization", () => {
  // Window besar (1M) dengan utilisasi rendah (< 30%) atau belum terdefinisi -> longgar
  assert.equal(isLooseContextWindow(1_000_000, 10), true);
  assert.equal(isLooseContextWindow(1_000_000, 29.9), true);
  assert.equal(isLooseContextWindow(1_000_000, undefined), true);
  assert.equal(isLooseContextWindow(1_000_000, null), true);

  // Window besar tapi utilisasi sudah moderat/tinggi (>= 30%) -> tidak longgar
  assert.equal(isLooseContextWindow(1_000_000, 30), false);
  assert.equal(isLooseContextWindow(1_000_000, 50), false);

  // Window standar/kecil (< 500k) -> tidak pernah dianggap longgar, fail-safe berlaku
  assert.equal(isLooseContextWindow(200_000, 5), false);
  assert.equal(isLooseContextWindow(128_000, 5), false);
  assert.equal(isLooseContextWindow(64_000, 5), false);
  assert.equal(isLooseContextWindow(undefined, 5), false);
  assert.equal(isLooseContextWindow(null, 5), false);
});

test("calculatePruneKeepLimit protects prompt cache for loose context windows", () => {
  const budget = 40_000;
  const live = 50_000;

  // Window 1M pada 10% utilisasi: tunda pruning (keepLimit = Infinity)
  assert.equal(calculatePruneKeepLimit(live, budget, 1_000_000, 10, 0.5), Number.POSITIVE_INFINITY);

  // Window 1M pada 35% utilisasi: aktifkan pruning turun ke watermark 50%
  assert.equal(calculatePruneKeepLimit(live, budget, 1_000_000, 35, 0.5), 20_000);
});

test("calculatePruneKeepLimit enforces fail-safe for small or unknown context windows", () => {
  const budget = 40_000;
  const live = 50_000;

  // Claude 200k: melebihi budget -> pangkas ke watermark 50%
  assert.equal(calculatePruneKeepLimit(live, budget, 200_000, 10, 0.5), 20_000);

  // DeepSeek 64k: melebihi budget -> pangkas ke watermark 50%
  assert.equal(calculatePruneKeepLimit(live, 12_800, 64_000, 10, 0.5), 6_400);

  // Context window tidak diketahui (null/undefined): fail-safe mengikat
  assert.equal(calculatePruneKeepLimit(live, budget, undefined, null, 0.5), 20_000);

  // Live tokens belum melampaui budget: tidak dipangkas
  assert.equal(calculatePruneKeepLimit(30_000, budget, 200_000, 10, 0.5), Number.POSITIVE_INFINITY);
});
