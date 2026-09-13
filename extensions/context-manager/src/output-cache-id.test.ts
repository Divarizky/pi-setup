import assert from "node:assert/strict";
import test from "node:test";
import { OutputCache } from "./output-cache.ts";

test("OutputCache menolak ID tidak valid (regex ketat 8 hex)", async () => {
  const cache = new OutputCache();
  assert.equal(await cache.get("output---"), null);
  assert.equal(await cache.get("output-zzzzzzzz"), null);
  assert.equal(await cache.get("output-abc"), null);
  assert.equal(await cache.get("output-123456789"), null);
  await cache.remove("output---");
  await cache.remove("output-zzzzzzzz");
});

test("OutputCache listActive hanya berisi ID sesi", async () => {
  const cache = new OutputCache();
  cache.resetSession();
  const id = await cache.save("hello");
  assert.ok(cache.listActive().includes(id));
  await cache.remove(id);
  assert.equal(cache.listActive().includes(id), false);
});
