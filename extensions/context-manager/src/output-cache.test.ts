import assert from "node:assert/strict";
import test from "node:test";
import { OutputCache } from "./output-cache.ts";

test("OutputCache stores and retrieves raw output by outputId", async () => {
  const cache = new OutputCache();
  const raw = "database timeout\nrequest failed";
  const outputId = await cache.save(raw);

  assert.match(outputId, /^output-[a-f0-9-]+$/);
  assert.equal(await cache.get(outputId), raw);
  assert.equal(await cache.get("output-does-not-exist"), null);

  await cache.remove(outputId);
  await cache.cleanup();
});
