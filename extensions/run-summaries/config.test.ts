import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SUMMARY_CONFIG,
  loadSummaryConfig,
  parseSummaryConfig,
  saveSummaryConfig,
} from "./src/config.ts";

test("summary config defaults to Codex Luna at medium reasoning", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "medium",
  });
});

test("summary config accepts valid private overrides and rejects partial corruption", () => {
  assert.deepEqual(
    parseSummaryConfig({
      provider: " anthropic ",
      model: " claude-sonnet ",
      reasoning: "high",
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    },
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});

test("saves and loads configuration atomically to custom path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-summaries-test-"));
  const configPath = join(dir, "config.json");
  try {
    const customConfig = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      reasoning: "high" as const,
    };
    await saveSummaryConfig(customConfig, undefined, configPath);
    const loaded = loadSummaryConfig(configPath);
    assert.deepEqual(loaded, customConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
