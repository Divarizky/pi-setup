import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAndEmitLoaded,
  applySettings,
  loadSettings,
  persistToastFor,
  type SettingsAppliers,
  saveAndEmitChanged,
  saveSettings,
} from "../src/settings.js";

describe("settings persistence", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  const globalFile = () => join(globalDir, "subagents.json");
  const projectFile = () => join(projectDir, ".pi", "subagents.json");

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-settings-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeGlobal(value: unknown) {
    writeFileSync(globalFile(), JSON.stringify(value));
  }

  function writeProject(value: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(value));
  }

  it("returns an empty object when both files are missing", () => {
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("merges global and project settings with project values winning", () => {
    writeGlobal({ maxConcurrent: 16, widgetMode: "all" });
    writeProject({ maxConcurrent: 4 });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 4, widgetMode: "all" });
  });

  it("ignores malformed files and warns only for files that exist", () => {
    writeFileSync(globalFile(), "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadSettings(projectDir)).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/Ignoring malformed settings/);
    } finally {
      warn.mockRestore();
    }
  });

  it("round-trips every persisted setting", () => {
    const settings = {
      maxConcurrent: 7,
      backgroundByDefault: false,
      defaultMaxTurns: 24,
      fleetView: false,
      agentMentions: "direct" as const,
      rememberAgents: false,
      widgetMode: "off" as const,
      worktreeIsolation: false,
      workflowsEnabled: false,
      agentControl: true,
    };
    saveSettings(settings, projectDir);
    expect(loadSettings(projectDir)).toEqual(settings);
  });

  it("migrates the legacy Firstmate-lite setting name on read", () => {
    writeProject({ firstmateLite: true });
    expect(loadSettings(projectDir)).toEqual({ agentControl: true });
  });

  it("accepts legacy boolean agentMentions values", () => {
    writeProject({ agentMentions: true });
    expect(loadSettings(projectDir)).toEqual({ agentMentions: "model" });
    writeProject({ agentMentions: false });
    expect(loadSettings(projectDir)).toEqual({ agentMentions: "off" });
  });

  it("drops invalid values and unknown fields", () => {
    writeProject({
      maxConcurrent: 0,
      defaultMaxTurns: -1,
      fleetView: "on",
      agentMentions: "invalid",
      rememberAgents: 1,
      widgetMode: "sideways",
      worktreeIsolation: null,
      workflowsEnabled: "yes",
      removedSetting: true,
    });
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("keeps valid fields when siblings are invalid", () => {
    writeProject({ maxConcurrent: 4, widgetMode: "background", removedSetting: true });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 4, widgetMode: "background" });
  });

  it("rejects values above numeric ceilings", () => {
    writeProject({ maxConcurrent: 1025, defaultMaxTurns: 257 });
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("returns an empty object when the JSON root is not an object", () => {
    for (const value of ["null", "[]", '"text"']) {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), value);
      expect(loadSettings(projectDir)).toEqual({});
    }
  });

  it("writes project settings without modifying global settings", () => {
    writeGlobal({ maxConcurrent: 16 });
    saveSettings({ maxConcurrent: 2 }, projectDir);
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 16 });
  });

  it("creates the project .pi directory when needed", () => {
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(saveSettings({ maxConcurrent: 4 }, projectDir)).toBe(true);
    expect(existsSync(projectFile())).toBe(true);
  });

  it("returns false when the settings path cannot be created", () => {
    const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
    writeFileSync(filePosingAsCwd, "");
    try {
      expect(saveSettings({ maxConcurrent: 1 }, filePosingAsCwd)).toBe(false);
    } finally {
      rmSync(filePosingAsCwd, { force: true });
    }
  });

  function makeAppliers(): SettingsAppliers {
    return {
      setMaxConcurrent: vi.fn(),
      setBackgroundByDefault: vi.fn(),
      setDefaultMaxTurns: vi.fn(),
      setFleetView: vi.fn(),
      setAgentMentions: vi.fn(),
      setRememberAgents: vi.fn(),
      setWidgetMode: vi.fn(),
      setWorktreeIsolation: vi.fn(),
      setWorkflowsEnabled: vi.fn(),
      setAgentControl: vi.fn(),
    };
  }

  it("applies all present settings and leaves absent settings untouched", () => {
    const appliers = makeAppliers();
    applySettings({
      maxConcurrent: 8,
      backgroundByDefault: false,
      defaultMaxTurns: 12,
      fleetView: false,
      agentMentions: "model",
      rememberAgents: true,
      widgetMode: "all",
      worktreeIsolation: true,
      workflowsEnabled: false,
      agentControl: true,
    }, appliers);

    expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(8);
    expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(false);
    expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(12);
    expect(appliers.setFleetView).toHaveBeenCalledWith(false);
    expect(appliers.setAgentMentions).toHaveBeenCalledWith("model");
    expect(appliers.setRememberAgents).toHaveBeenCalledWith(true);
    expect(appliers.setWidgetMode).toHaveBeenCalledWith("all");
    expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(true);
    expect(appliers.setWorkflowsEnabled).toHaveBeenCalledWith(false);
    expect(appliers.setAgentControl).toHaveBeenCalledWith(true);

    const empty = makeAppliers();
    applySettings({}, empty);
    for (const applier of Object.values(empty)) expect(applier).not.toHaveBeenCalled();
  });

  it("loads, applies, and emits the settings_loaded event", () => {
    writeGlobal({ maxConcurrent: 16 });
    writeProject({ widgetMode: "off" });
    const appliers = makeAppliers();
    const emit = vi.fn();

    const result = applyAndEmitLoaded(appliers, emit, projectDir);

    expect(result).toEqual({ maxConcurrent: 16, widgetMode: "off" });
    expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(16);
    expect(appliers.setWidgetMode).toHaveBeenCalledWith("off");
    expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: result });
  });

  it("formats persistence toasts", () => {
    expect(persistToastFor("Updated", true)).toEqual({ message: "Updated", level: "info" });
    expect(persistToastFor("Updated", false)).toEqual({
      message: "Updated (session only; failed to persist)",
      level: "warning",
    });
  });

  it("saves and emits settings_changed on success", () => {
    const emit = vi.fn();
    const snapshot = { maxConcurrent: 5 };
    expect(saveAndEmitChanged(snapshot, "Updated", emit, projectDir)).toEqual({
      message: "Updated",
      level: "info",
    });
    expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
      settings: snapshot,
      persisted: true,
    });
  });

  it("emits persisted=false and a warning when saving fails", () => {
    const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
    writeFileSync(filePosingAsCwd, "");
    const emit = vi.fn();
    try {
      expect(saveAndEmitChanged({ maxConcurrent: 5 }, "Updated", emit, filePosingAsCwd)).toEqual({
        message: "Updated (session only; failed to persist)",
        level: "warning",
      });
      expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
        settings: { maxConcurrent: 5 },
        persisted: false,
      });
    } finally {
      rmSync(filePosingAsCwd, { force: true });
    }
  });
});
