import assert from "node:assert/strict";
import test from "node:test";
import { canRetry, retryDelay } from "../src/recovery.ts";

test("retry policy uses bounded exponential backoff", () => {
  assert.equal(retryDelay(1), 250);
  assert.equal(retryDelay(2), 500);
  assert.equal(retryDelay(3), 1_000);
  assert.equal(retryDelay(99), 5_000);
});

test("retry policy only allows failed jobs within the attempt limit", () => {
  assert.equal(
    canRetry({ status: "done", metrics: { restartCount: 0 } }),
    false,
  );
  assert.equal(
    canRetry({ status: "failed", metrics: { restartCount: 0 } }),
    true,
  );
  assert.equal(
    canRetry({ status: "failed", metrics: { restartCount: 3 } }),
    false,
  );
});
