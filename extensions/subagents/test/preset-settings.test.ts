import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPresetSetting,
  buildPresetSettingItems,
  presetSettingId,
} from "../src/preset-settings.js";
import { loadPresets, savePresets } from "../src/presets.js";
import { BUILTIN_AGENT_TYPES } from "../src/types.js";

describe("per-type preset settings UI", () => {
  let directory: string | undefined;
  let agentDirectory: string | undefined;
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDirectory = mkdtempSync(join(tmpdir(), "pi-preset-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
  });

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (agentDirectory) rmSync(agentDirectory, { recursive: true, force: true });
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  });

  it("renders model, max-turns, and thinking rows for every built-in type", () => {
    const items = buildPresetSettingItems(new Map());

    expect(items).toHaveLength(BUILTIN_AGENT_TYPES.length * 3);
    for (const type of BUILTIN_AGENT_TYPES) {
      expect(items.map(item => item.id)).toEqual(expect.arrayContaining([
        presetSettingId(type, "model"),
        presetSettingId(type, "maxTurns"),
        presetSettingId(type, "thinking"),
      ]));
    }
    expect(items.find(item => item.id === presetSettingId("explore", "thinking"))?.values)
      .toContain("high");
  });

  it("edits each type independently and supports resetting to defaults", () => {
    const presets = new Map<string, any>();

    for (const type of BUILTIN_AGENT_TYPES) {
      expect(applyPresetSetting(presets, presetSettingId(type, "model"), `${type}/model`)).toBe(true);
      expect(applyPresetSetting(presets, presetSettingId(type, "maxTurns"), "24")).toBe(true);
      expect(applyPresetSetting(presets, presetSettingId(type, "thinking"), "high")).toBe(true);
    }

    expect(presets.get("explore")).toMatchObject({ model: "explore/model", maxTurns: 24, thinking: "high" });
    expect(presets.get("build")).toMatchObject({ model: "build/model", maxTurns: 24, thinking: "high" });
    expect(presets.get("general")).toMatchObject({ model: "general/model", maxTurns: 24, thinking: "high" });

    expect(applyPresetSetting(presets, presetSettingId("build", "model"), "default")).toBe(true);
    expect(applyPresetSetting(presets, presetSettingId("build", "maxTurns"), "default")).toBe(true);
    expect(applyPresetSetting(presets, presetSettingId("build", "thinking"), "default")).toBe(true);
    expect(presets.get("build")).toEqual({});
    expect(presets.get("explore")).toMatchObject({ model: "explore/model" });
  });

  it("persists edited rows to project .pi/subagents.yaml and reloads them", () => {
    directory = mkdtempSync(join(tmpdir(), "pi-preset-settings-"));
    const presets = new Map<string, any>([
      ["explore", { model: "local/explore", maxTurns: 12, thinking: "medium" }],
      ["build", { model: "local/build", maxTurns: 30, thinking: "high" }],
      ["general", { model: "local/general", maxTurns: 40, thinking: "low" }],
    ]);

    expect(savePresets(presets as any, directory)).toBe(true);
    const file = join(directory, ".pi", "subagents.yaml");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("explore:");

    const loaded = loadPresets(directory);
    expect(loaded.presets.get("explore")).toMatchObject({ model: "local/explore", maxTurns: 12, thinking: "medium" });
    expect(loaded.presets.get("build")).toMatchObject({ model: "local/build", maxTurns: 30, thinking: "high" });
    expect(loaded.presets.get("general")).toMatchObject({ model: "local/general", maxTurns: 40, thinking: "low" });
  });

  it("rejects invalid values without corrupting the existing preset", () => {
    const presets = new Map<string, any>([["explore", { model: "keep/model" }]]);

    expect(applyPresetSetting(presets, presetSettingId("explore", "maxTurns"), "-1")).toBe(false);
    expect(applyPresetSetting(presets, presetSettingId("explore", "thinking"), "turbo")).toBe(false);
    expect(applyPresetSetting(presets, "preset/reviewer/model", "bad")).toBe(false);
    expect(presets.get("explore")).toEqual({ model: "keep/model" });
  });
});
