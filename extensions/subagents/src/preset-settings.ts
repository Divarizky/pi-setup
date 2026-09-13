import type { SettingItem } from "@earendil-works/pi-tui";
import type { ModelRegistry } from "./model-resolver.js";
import type { AgentPreset } from "./presets.js";
import { BUILTIN_AGENT_TYPES } from "./types.js";

export const PRESET_SETTING_PREFIX = "preset.";
export const PRESET_THINKING_VALUES = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PresetSettingField = "model" | "maxTurns" | "thinking";

export function presetSettingId(type: string, field: PresetSettingField): string {
  return `${PRESET_SETTING_PREFIX}${type}.${field}`;
}

export function parsePresetSettingId(id: string): { type: string; field: PresetSettingField } | undefined {
  if (!id.startsWith(PRESET_SETTING_PREFIX)) return undefined;
  const [type, field] = id.slice(PRESET_SETTING_PREFIX.length).split(".");
  if ((field !== "model" && field !== "maxTurns" && field !== "thinking") || !type) return undefined;
  return { type, field };
}

/** All models in the catalogue, sorted as `provider/id`. Same set `/model` shows. */
export function presetModelChoices(registry?: ModelRegistry): string[] {
  if (!registry) return ["default"];
  const ids = (registry.getAvailable?.() ?? registry.getAll()).map(m => `${m.provider}/${m.id}`);
  return ["default", ...Array.from(new Set(ids)).sort()];
}

/**
 * SettingsList rows for the three built-in preset types.
 *
 * Pass `registry` (ctx.modelRegistry) so the model rows offer a picker
 * submenu with every catalogue model; without it the rows keep the old
 * single-value behaviour. Pass `createModelSubmenu` to wire the actual
 * SelectList component — lives in index.ts where TUI imports already exist.
 */
export function buildPresetSettingItems(
  presets: ReadonlyMap<string, AgentPreset>,
  registry?: ModelRegistry,
  createModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => import("@earendil-works/pi-tui").Component,
): SettingItem[] {
  return BUILTIN_AGENT_TYPES.flatMap(type => {
    const preset = presets.get(type) ?? {};
    const model = preset.model ?? "default";
    const maxTurns = preset.maxTurns === undefined ? "default" : String(preset.maxTurns);
    const thinking = preset.thinking ?? "default";
    return [
      {
        id: presetSettingId(type, "model"),
        label: `${type} model`,
        description: `Model override for the ${type} built-in agent (Enter to pick from available models; default inherits the parent model)`,
        currentValue: model,
        // Single-value list: Enter fires onChange without cycling; the real
        // picker lives in the `submenu` below (same pattern as theme settings).
        // ponytail: no free-text typing here; add when users need models outside the catalogue.
        values: [model],
        ...(createModelSubmenu && registry ? { submenu: createModelSubmenu } : {}),
      },
      {
        id: presetSettingId(type, "maxTurns"),
        label: `${type} max turns`,
        description: `Maximum turns for the ${type} built-in agent (Enter to type; default uses the global setting)`,
        currentValue: maxTurns,
        values: [maxTurns],
      },
      {
        id: presetSettingId(type, "thinking"),
        label: `${type} thinking`,
        description: `Thinking level for the ${type} built-in agent; default inherits the parent setting`,
        currentValue: thinking,
        values: [...PRESET_THINKING_VALUES],
      },
    ];
  });
}

/** Apply one SettingsList value. Returns false when the value is invalid. */
export function applyPresetSetting(
  presets: Map<string, AgentPreset>,
  id: string,
  value: string,
): boolean {
  const parsed = parsePresetSettingId(id);
  if (!parsed || !BUILTIN_AGENT_TYPES.includes(parsed.type as (typeof BUILTIN_AGENT_TYPES)[number])) return false;

  const previous = presets.get(parsed.type) ?? {};
  const next: AgentPreset = { ...previous };
  if (parsed.field === "model") {
    const model = value.trim();
    if (model === "" || model === "default") delete next.model;
    else next.model = model;
  } else if (parsed.field === "maxTurns") {
    if (value === "default") delete next.maxTurns;
    else {
      const maxTurns = Number(value.trim());
      if (!Number.isInteger(maxTurns) || maxTurns < 0 || maxTurns > 10_000) return false;
      next.maxTurns = maxTurns;
    }
  } else {
    if (!PRESET_THINKING_VALUES.includes(value as (typeof PRESET_THINKING_VALUES)[number])) return false;
    if (value === "default") delete next.thinking;
    else next.thinking = value as AgentPreset["thinking"];
  }

  presets.set(parsed.type, next);
  return true;
}
