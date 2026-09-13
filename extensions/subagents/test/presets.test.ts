import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRegistry, getAvailableTypes, registerAgents, setBuiltinPresets } from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { loadPresets, parsePresetYaml } from "../src/presets.js";
import { BUILTIN_AGENT_TYPES } from "../src/types.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

describe("built-in agent presets", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "subagents-presets-"));
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tempDir, { recursive: true, force: true });
    registerAgents(new Map());
    setBuiltinPresets(undefined);
  });

  it("exposes exactly the three canonical built-in types", () => {
    expect([...DEFAULT_AGENTS.keys()].sort()).toEqual([...BUILTIN_AGENT_TYPES].sort());
    registerAgents(new Map());
    expect(getAvailableTypes().sort()).toEqual([...BUILTIN_AGENT_TYPES].sort());
  });

  it("parses operational fields without creating a custom registry", () => {
    const parsed = parsePresetYaml(`presets:
  explore:
    model: anthropic/claude-haiku-4-5
    thinking: low
    max_turns: 40
    context: isolated
    background: true
    concurrency: 3
    tools: [read, grep, find]
    network: false
    skills: [review]
    extensions: [git-info]
    workspace: main
`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.presets.get("explore")).toMatchObject({
      model: "anthropic/claude-haiku-4-5",
      thinking: "low",
      maxTurns: 40,
      context: "isolated",
      background: true,
      concurrency: 3,
      tools: ["read", "grep", "find"],
      network: false,
      skills: ["review"],
      extensions: ["git-info"],
      workspace: "main",
    });
    expect(parsed.presets.has("review")).toBe(false);
  });

  it("applies model, thinking, and max-turn overlays to built-ins", () => {
    const parsed = parsePresetYaml("explore:\n  model: local/explorer\n  thinking: low\n  max_turns: 12\n");
    setBuiltinPresets(parsed.presets);
    const config = buildAgentRegistry(new Map()).get("explore");
    expect(config).toMatchObject({ model: "local/explorer", thinking: "low", maxTurns: 12 });
  });

  it("supports project-over-global precedence", () => {
    writeFileSync(join(tempDir, "subagents.yaml"), "general:\n  model: global-model\n");
    const project = mkdtempSync(join(tempDir, "project-"));
    const piDir = join(project, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "subagents.yaml"), "general:\n  model: project-model\n");

    const result = loadPresets(project);
    expect(result.files).toEqual([join(tempDir, "subagents.yaml"), join(piDir, "subagents.yaml")]);
    expect(result.presets.get("general")?.model).toBe("project-model");
  });

  it("rejects custom agent names and complex identity fields with diagnostics", () => {
    const parsed = parsePresetYaml(`presets:
  reviewer:
    model: anthropic/claude-sonnet-4-6
  explore:
    name: reviewer
    description: Custom reviewer
    system_prompt: Do anything
    tools: [read, ext:search]
`);

    expect([...parsed.presets.keys()]).not.toContain("reviewer");
    expect(parsed.presets.get("explore")).toMatchObject({ tools: ["read"] });
    expect(parsed.diagnostics.map(d => d.message).join("\n")).toMatch(/custom-agent registry|Custom agent field|not a built-in tool/i);
    expect(parsed.diagnostics.some(d => d.path === "reviewer")).toBe(true);
    expect(parsed.diagnostics.some(d => d.path === "explore.name")).toBe(true);
  });

  it("reports invalid values while retaining valid fields", () => {
    const parsed = parsePresetYaml(`explore:
  thinking: turbo
  max_turns: -1
  background: yes
  concurrency: 0
  workspace: remote
  model: valid-model
`);

    expect(parsed.presets.get("explore")).toMatchObject({ model: "valid-model" });
    expect(parsed.presets.get("explore")?.thinking).toBeUndefined();
    expect(parsed.diagnostics).toHaveLength(5);
  });

});
