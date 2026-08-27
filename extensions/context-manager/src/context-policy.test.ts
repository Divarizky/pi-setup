import assert from "node:assert/strict";
import test from "node:test";
import {
  formatContextPercent,
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

test("formatContextPercent handles known and unknown usage", () => {
  assert.equal(formatContextPercent(62.4), "62%");
  assert.equal(formatContextPercent(null), "tidak diketahui");
});
