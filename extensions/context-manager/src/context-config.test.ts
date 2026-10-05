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
  resolveToolOutputBudgetTokens,
  saveContextManagerConfig,
} from "./context-config.ts";

test("context manager config uses defaults for missing or invalid values", () => {
  assert.deepEqual(parseContextManagerConfig(undefined), DEFAULT_CONTEXT_MANAGER_CONFIG);
  assert.deepEqual(
    parseContextManagerConfig({
      outputCharThreshold: 0,
      outputLineThreshold: "500",
      contextBudgetPercent: 31,
      toolOutputBudgetTokens: 1,
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
      toolOutputBudgetTokens: 30_000,
    }),
    {
      outputCharThreshold: 20_000,
      outputLineThreshold: 750,
      contextBudgetPercent: 25,
      toolOutputBudgetTokens: 30_000,
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
    toolOutputBudgetTokens: 30_000,
  } as const;

  try {
    await saveContextManagerConfig(config, path);
    assert.deepEqual(loadContextManagerConfig(path), config);
    await resetContextManagerConfig(path);
    assert.deepEqual(loadContextManagerConfig(path), DEFAULT_CONTEXT_MANAGER_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool output budget is absolute and capped by context window percent", () => {
  const config = DEFAULT_CONTEXT_MANAGER_CONFIG;
  // Window besar tidak menaikkan budget di atas nilai absolut.
  assert.equal(resolveToolOutputBudgetTokens(config, 1_000_000), config.toolOutputBudgetTokens);
  // Window kecil membatasi budget ke persen window.
  assert.equal(resolveToolOutputBudgetTokens(config, 32_000), Math.floor(32_000 * config.contextBudgetPercent / 100));
  assert.equal(resolveToolOutputBudgetTokens(config, undefined), config.toolOutputBudgetTokens);
});
