import assert from "node:assert/strict";
import test from "node:test";
import { withDurableWrite } from "../src/durable-write.ts";

test("durable writes retry transient failures with bounded backoff", async () => {
  let attempts = 0;
  const value = await withDurableWrite(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("temporary filesystem failure");
      return "written";
    },
    { baseDelayMs: 0 },
  );
  assert.equal(value, "written");
  assert.equal(attempts, 3);
});

test("durable writes stop after the configured attempts", async () => {
  let attempts = 0;
  await assert.rejects(
    withDurableWrite(
      async () => {
        attempts++;
        throw new Error("permanent filesystem failure");
      },
      { attempts: 2, baseDelayMs: 0 },
    ),
    /permanent filesystem failure/,
  );
  assert.equal(attempts, 2);
});
