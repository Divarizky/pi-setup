/**
 * YAML presets for the three built-in subagent types.
 *
 * Presets are deliberately an overlay, not another agent registry. They may
 * tune the operational policy of `explore`, `build`, and `general`,
 * but cannot define a new prompt, identity, or arbitrary custom agent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { BuiltinAgentType, ThinkingLevel } from "./types.js";
import { BUILTIN_AGENT_TYPES } from "./types.js";

const PRESET_FILE_NAMES = ["subagents.yaml", "subagents.yml"] as const;
const PRESET_TYPES: readonly BuiltinAgentType[] = BUILTIN_AGENT_TYPES;
const PRESET_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PRESET_FIELDS = new Set([
  "model",
  "thinking",
  "max_turns",
  "context",
  "background",
  "concurrency",
  "tools",
  "network",
  "skills",
  "extensions",
  "workspace",
]);
const COMPLEX_AGENT_FIELDS = new Set([
  "name",
  "display_name",
  "description",
  "prompt",
  "system_prompt",
  "prompt_mode",
  "allowed_subagents",
  "memory",
  "persist_session",
  "output_transcript",
  "session_dir",
  "inherit_context",
  "run_in_background",
  "isolated",
  "enabled",
  "color",
]);

export type PresetContext = "inherit" | "isolated" | "default";
export type PresetWorkspace = "main" | "worktree" | "auto";
export type PresetCapabilities = true | false | string[];

export interface AgentPreset {
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  context?: PresetContext;
  background?: boolean;
  concurrency?: number;
  tools?: string[];
  network?: boolean;
  skills?: PresetCapabilities;
  extensions?: PresetCapabilities;
  workspace?: PresetWorkspace;
  sourcePath?: string;
}

export interface PresetDiagnostic {
  sourcePath: string;
  path: string;
  message: string;
}

export interface PresetParseResult {
  presets: Map<BuiltinAgentType, AgentPreset>;
  diagnostics: PresetDiagnostic[];
}

export interface LoadedPresets extends PresetParseResult {
  files: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(
  diagnostics: PresetDiagnostic[],
  sourcePath: string,
  path: string,
  message: string,
): void {
  diagnostics.push({ sourcePath, path, message });
}

function parseYaml(content: string): Record<string, unknown> {
  const source = content.startsWith("\uFEFF") ? content.slice(1) : content;
  // parseFrontmatter is Pi's YAML parser. Wrapping a plain YAML document in a
  // fence lets the preset file stay concise while still using the host parser.
  const wrapped = source.trimStart().startsWith("---")
    ? source
    : `---\n${source}\n---\n`;
  const parsed = parseFrontmatter<Record<string, unknown>>(wrapped);
  return parsed.frontmatter;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseCapabilities(
  value: unknown,
  diagnostics: PresetDiagnostic[],
  sourcePath: string,
  fieldPath: string,
): PresetCapabilities | undefined {
  if (value === false || value === "none") return false;
  if (value === true || value === "all" || value === "*") return true;
  if (value === null || value === undefined) return undefined;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!values) return undefined;

  const strings: string[] = [];
  for (const item of values) {
    if (typeof item !== "string" || !item.trim()) {
      diagnostic(diagnostics, sourcePath, fieldPath, `${fieldPath.split(".").at(-1)} entries must be non-empty strings.`);
      continue;
    }
    strings.push(item.trim());
  }
  return strings;
}

function parseTools(
  value: unknown,
  diagnostics: PresetDiagnostic[],
  sourcePath: string,
  fieldPath: string,
): string[] | undefined {
  if (value === "all" || value === "*") return [...PRESET_TOOLS];
  if (value === "none" || value === null) return [];
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!values) {
    diagnostic(diagnostics, sourcePath, fieldPath, "tools must be a CSV string, YAML list, `all`, or `none`.");
    return undefined;
  }
  const tools: string[] = [];
  for (const item of values) {
    if (typeof item !== "string" || !item.trim()) {
      diagnostic(diagnostics, sourcePath, fieldPath, "tools entries must be non-empty built-in tool names.");
      continue;
    }
    const tool = item.trim();
    if (tool === "all" || tool === "*") {
      tools.push(...PRESET_TOOLS);
    } else if ((PRESET_TOOLS as readonly string[]).includes(tool)) {
      tools.push(tool);
    } else {
      diagnostic(
        diagnostics,
        sourcePath,
        fieldPath,
        `Tool "${tool}" is not a built-in tool. Presets cannot register custom or extension tools; use extensions separately.`,
      );
    }
  }
  return [...new Set(tools)];
}

function parsePreset(
  value: unknown,
  sourcePath: string,
  type: BuiltinAgentType,
  diagnostics: PresetDiagnostic[],
): AgentPreset | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, sourcePath, type, "Preset must be a YAML mapping of operational fields.");
    return undefined;
  }

  const preset: AgentPreset = { sourcePath };
  for (const [field, raw] of Object.entries(value)) {
    const fieldPath = `${type}.${field}`;
    if (!PRESET_FIELDS.has(field)) {
      const message = COMPLEX_AGENT_FIELDS.has(field)
        ? `Custom agent field "${field}" is not supported in a built-in preset. Presets configure policy only.`
        : `Unknown preset field "${field}". Allowed fields: ${[...PRESET_FIELDS].join(", ")}.`;
      diagnostic(diagnostics, sourcePath, fieldPath, message);
      continue;
    }

    switch (field) {
      case "model": {
        const model = parseString(raw);
        if (model) preset.model = model;
        else diagnostic(diagnostics, sourcePath, fieldPath, "model must be a non-empty string.");
        break;
      }
      case "thinking": {
        const thinking = parseString(raw) as ThinkingLevel | undefined;
        if (thinking && THINKING_LEVELS.has(thinking)) preset.thinking = thinking;
        else diagnostic(diagnostics, sourcePath, fieldPath, "thinking must be one of off, minimal, low, medium, high, xhigh, or max.");
        break;
      }
      case "max_turns":
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 10_000) preset.maxTurns = raw;
        else diagnostic(diagnostics, sourcePath, fieldPath, "max_turns must be an integer from 0 to 10000; 0 means unlimited.");
        break;
      case "context": {
        const context = parseString(raw) as PresetContext | undefined;
        if (context === "inherit" || context === "isolated" || context === "default") preset.context = context;
        else diagnostic(diagnostics, sourcePath, fieldPath, "context must be inherit, isolated, or default.");
        break;
      }
      case "background":
        if (typeof raw === "boolean") preset.background = raw;
        else diagnostic(diagnostics, sourcePath, fieldPath, "background must be a boolean.");
        break;
      case "concurrency":
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 1024) preset.concurrency = raw;
        else diagnostic(diagnostics, sourcePath, fieldPath, "concurrency must be an integer from 1 to 1024.");
        break;
      case "tools":
        preset.tools = parseTools(raw, diagnostics, sourcePath, fieldPath);
        break;
      case "network":
        if (typeof raw === "boolean") preset.network = raw;
        else diagnostic(diagnostics, sourcePath, fieldPath, "network must be a boolean.");
        break;
      case "skills":
      case "extensions": {
        const capabilities = parseCapabilities(raw, diagnostics, sourcePath, fieldPath);
        if (capabilities === undefined) {
          diagnostic(diagnostics, sourcePath, fieldPath, `${field} must be a boolean, CSV string, or YAML list.`);
        } else if (field === "skills") {
          preset.skills = capabilities;
        } else {
          preset.extensions = capabilities;
        }
        break;
      }
      case "workspace": {
        const workspace = parseString(raw) as PresetWorkspace | undefined;
        if (workspace === "main" || workspace === "worktree" || workspace === "auto") preset.workspace = workspace;
        else diagnostic(diagnostics, sourcePath, fieldPath, "workspace must be main, worktree, or auto.");
        break;
      }
    }
  }
  return preset;
}

/** Parse one inline or file-shaped YAML preset document without touching disk. */
export function parsePresetYaml(content: string, sourcePath = "<inline>"): PresetParseResult {
  const presets = new Map<BuiltinAgentType, AgentPreset>();
  const diagnostics: PresetDiagnostic[] = [];
  let root: Record<string, unknown>;
  try {
    root = parseYaml(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    diagnostic(diagnostics, sourcePath, "<document>", `Invalid YAML: ${reason}`);
    return { presets, diagnostics };
  }

  let entries: unknown = root;
  if (Object.hasOwn(root, "version")) {
    if (root.version !== 1 && root.version !== "1") {
      diagnostic(diagnostics, sourcePath, "version", "Preset version must be 1.");
    }
    if (!Object.hasOwn(root, "presets")) {
      entries = { ...root };
      delete (entries as Record<string, unknown>).version;
    }
  }
  if (Object.hasOwn(root, "presets")) {
    const extra = Object.keys(root).filter(key => key !== "presets" && key !== "version");
    for (const key of extra) {
      diagnostic(diagnostics, sourcePath, key, `Unknown top-level field "${key}". Use a single presets mapping.`);
    }
    entries = root.presets;
  }
  if (!isRecord(entries)) {
    diagnostic(diagnostics, sourcePath, "presets", "presets must be a YAML mapping keyed by explore, build, or general.");
    return { presets, diagnostics };
  }

  for (const [type, value] of Object.entries(entries)) {
    if (type === "agents" || type === "custom_agents") {
      diagnostic(
        diagnostics,
        sourcePath,
        type,
        "Custom agent definitions are not supported in presets; configure one of the three built-in types instead.",
      );
      continue;
    }
    if (!(PRESET_TYPES as readonly string[]).includes(type)) {
      diagnostic(
        diagnostics,
        sourcePath,
        type,
        `Unknown built-in preset "${type}". Only ${PRESET_TYPES.join(", ")} are supported; presets cannot become a custom-agent registry.`,
      );
      continue;
    }
    const preset = parsePreset(value, sourcePath, type as BuiltinAgentType, diagnostics);
    if (preset) presets.set(type as BuiltinAgentType, preset);
  }
  return { presets, diagnostics };
}

function findPresetFile(root: string): string | undefined {
  for (const name of PRESET_FILE_NAMES) {
    const file = join(root, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Load global and project presets; project values override global values. */
export function loadPresets(cwd: string = process.cwd()): LoadedPresets {
  const result: LoadedPresets = { presets: new Map(), diagnostics: [], files: [] };
  const roots = [getAgentDir(), join(cwd, ".pi")];
  for (const root of roots) {
    const file = findPresetFile(root);
    if (!file) continue;
    result.files.push(file);
    try {
      const parsed = parsePresetYaml(readFileSync(file, "utf-8"), file);
      result.diagnostics.push(...parsed.diagnostics);
      for (const [type, preset] of parsed.presets) result.presets.set(type, preset);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      diagnostic(result.diagnostics, file, "<document>", `Unable to read preset file: ${reason}`);
    }
  }
  return result;
}

export const BUILTIN_PRESET_TYPES = PRESET_TYPES;
export const PRESET_ALLOWED_FIELDS = [...PRESET_FIELDS] as const;

const PRESET_YAML_INDENT = "  ";

function quoteYamlString(value: string): string {
  return '"' + value.replace(/"/g, '\\"') + '"';
}

export function serializePresets(presets: Map<BuiltinAgentType, AgentPreset>): string {
  const lines: string[] = [];
  for (const t of PRESET_TYPES) {
    const p = presets.get(t);
    if (!p) continue;
    lines.push(t + ":");
    if (p.model !== undefined) lines.push(PRESET_YAML_INDENT + "model: " + quoteYamlString(p.model));
    if (p.thinking !== undefined) lines.push(PRESET_YAML_INDENT + "thinking: " + p.thinking);
    if (p.maxTurns !== undefined) lines.push(PRESET_YAML_INDENT + "max_turns: " + String(p.maxTurns));
    if (p.context !== undefined) lines.push(PRESET_YAML_INDENT + "context: " + String(p.context));
    if (p.background !== undefined) lines.push(PRESET_YAML_INDENT + "background: " + String(p.background));
    if (p.concurrency !== undefined) lines.push(PRESET_YAML_INDENT + "concurrency: " + String(p.concurrency));
    if (p.tools !== undefined) lines.push(PRESET_YAML_INDENT + "tools: [" + p.tools.join(", ") + "]");
    if (p.network !== undefined) lines.push(PRESET_YAML_INDENT + "network: " + String(p.network));
    if (p.workspace !== undefined) lines.push(PRESET_YAML_INDENT + "workspace: " + String(p.workspace));
    if (p.skills !== undefined) lines.push(PRESET_YAML_INDENT + "skills: " + (typeof p.skills === "boolean" ? String(p.skills) : "[" + (p.skills as string[]).join(", ") + "]"));
    if (p.extensions !== undefined) lines.push(PRESET_YAML_INDENT + "extensions: " + (typeof p.extensions === "boolean" ? String(p.extensions) : "[" + (p.extensions as string[]).join(", ") + "]"));
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function savePresets(presets: Map<BuiltinAgentType, AgentPreset>, cwd: string = process.cwd()): boolean {
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.yaml"), serializePresets(presets), "utf-8");
    return true;
  } catch { return false; }
}
