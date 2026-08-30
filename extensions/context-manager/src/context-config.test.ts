import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_CONTEXT_MANAGER_CONFIG,
  loadContextManagerConfig,
  parseContextManagerConfig,
  resetContextManagerConfig,
  saveContextManagerConfig,
} from "./context-config.ts";

test("context manager config uses defaults for missing or invalid values", () => {
  assert.deepEqual(
    parseContextManagerConfig(undefined),
    DEFAULT_CONTEXT_MANAGER_CONFIG,
  );
  assert.deepEqual(
    parseContextManagerConfig({
      outputCharThreshold: 0,
      outputLineThreshold: "500",
      contextBudgetPercent: 31,
    }),
    DEFAULT_CONTEXT_MANAGER_CONFIG,
  );
});

test("context manager config accepts valid overrides", () => {
  assert.deepEqual(
    parseContextManagerConfig({
      outputCharThreshold: 20_000,
      outputLineThreshold: 750,
      contextBudgetPercent: 25,
    }),
    {
      outputCharThreshold: 20_000,
      outputLineThreshold: 750,
      contextBudgetPercent: 25,
    },
  );
});

test("context manager config saves, loads, and resets atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-manager-test-"));
  const path = join(dir, "context-manager.config.json");
  const config = {
    outputCharThreshold: 20_000,
    outputLineThreshold: 750,
    contextBudgetPercent: 25,
  } as const;

  try {
    await saveContextManagerConfig(config, path);
    assert.deepEqual(loadContextManagerConfig(path), config);
    await resetContextManagerConfig(path);
    assert.deepEqual(
      loadContextManagerConfig(path),
      DEFAULT_CONTEXT_MANAGER_CONFIG,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
