import assert from "node:assert/strict";
import test from "node:test";
import { SummaryQueue } from "./src/summary-queue.ts";

test("summary queue never exceeds its concurrency limit and preserves order", async () => {
  const queue = new SummaryQueue({ concurrency: 1 });
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  for (const value of [1, 2, 3]) {
    queue.enqueue(async () => {
      active++;
      peak = Math.max(peak, active);
      await wait(2);
      order.push(value);
      active--;
    });
  }

  await queue.waitForActive();
  assert.equal(peak, 1);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(queue.pendingCount, 0);
});

test("closing the queue cancels pending work but lets active work finish", async () => {
  const queue = new SummaryQueue({ concurrency: 1 });
  let completed = 0;
  let release!: () => void;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });

  queue.enqueue(async () => {
    await active;
    completed++;
  });
  queue.enqueue(async () => {
    completed++;
  });
  queue.close();
  release();

  await queue.waitForActive();
  assert.equal(completed, 1);
  assert.equal(queue.pendingCount, 0);
});
