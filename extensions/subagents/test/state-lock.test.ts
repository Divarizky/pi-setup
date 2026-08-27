import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireStateLease,
  disposeWithStateLease,
  StateLeaseError,
} from "../src/state-lock.ts";

test("state lease rejects a second live owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-state-lock-"));
  try {
    const first = await acquireStateLease(root);
    await assert.rejects(
      acquireStateLease(root, { waitMs: 20 }),
      (error: unknown) =>
        error instanceof StateLeaseError &&
        /owned by a live runtime/.test(error.message),
    );
    await first.release();
    const second = await acquireStateLease(root);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state lease is released when runtime disposal fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-state-lock-"));
  try {
    const first = await acquireStateLease(root);
    await assert.rejects(
      disposeWithStateLease(async () => {
        throw new Error("dispose failed");
      }, first),
      /dispose failed/,
    );
    const second = await acquireStateLease(root);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state lease removes an abandoned dead-process lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-state-lock-"));
  try {
    await writeFile(
      path.join(root, ".subagents-state.lock"),
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        token: "dead",
        createdAt: 0,
      }),
    );
    const second = await acquireStateLease(root);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
