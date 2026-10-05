import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_OUTPUT_CHAR_THRESHOLD = 8_000;
export const DEFAULT_OUTPUT_LINE_THRESHOLD = 300;
export const DEFAULT_CONTEXT_BUDGET_PERCENT = 20;
// Budget absolut: biaya dihitung per token, bukan per persen context window.
export const DEFAULT_TOOL_OUTPUT_BUDGET_TOKENS = 24_000;
export const MIN_TOOL_OUTPUT_BUDGET_TOKENS = 4_000;
export const MAX_TOOL_OUTPUT_BUDGET_TOKENS = 200_000;
export const MIN_CONTEXT_BUDGET_PERCENT = 15;
export const MAX_CONTEXT_BUDGET_PERCENT = 30;

export const MIN_OUTPUT_CHAR_THRESHOLD = 1_000;
export const MAX_OUTPUT_CHAR_THRESHOLD = 1_000_000;
export const MIN_OUTPUT_LINE_THRESHOLD = 50;
export const MAX_OUTPUT_LINE_THRESHOLD = 100_000;

export interface ContextManagerConfig {
  readonly outputCharThreshold: number;
  readonly outputLineThreshold: number;
  readonly contextBudgetPercent: number;
  readonly toolOutputBudgetTokens: number;
}

export const DEFAULT_CONTEXT_MANAGER_CONFIG: ContextManagerConfig = {
  outputCharThreshold: DEFAULT_OUTPUT_CHAR_THRESHOLD,
  outputLineThreshold: DEFAULT_OUTPUT_LINE_THRESHOLD,
  contextBudgetPercent: DEFAULT_CONTEXT_BUDGET_PERCENT,
  toolOutputBudgetTokens: DEFAULT_TOOL_OUTPUT_BUDGET_TOKENS,
};

export function getContextManagerConfigPath(): string {
  return join(getAgentDir(), "context-manager.config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parseContextManagerConfig(value: unknown): ContextManagerConfig {
  if (!isRecord(value)) return DEFAULT_CONTEXT_MANAGER_CONFIG;

  return {
    outputCharThreshold: integerInRange(
      value.outputCharThreshold,
      MIN_OUTPUT_CHAR_THRESHOLD,
      MAX_OUTPUT_CHAR_THRESHOLD,
    )
      ? value.outputCharThreshold
      : DEFAULT_OUTPUT_CHAR_THRESHOLD,
    outputLineThreshold: integerInRange(
      value.outputLineThreshold,
      MIN_OUTPUT_LINE_THRESHOLD,
      MAX_OUTPUT_LINE_THRESHOLD,
    )
      ? value.outputLineThreshold
      : DEFAULT_OUTPUT_LINE_THRESHOLD,
    contextBudgetPercent: integerInRange(
      value.contextBudgetPercent,
      MIN_CONTEXT_BUDGET_PERCENT,
      MAX_CONTEXT_BUDGET_PERCENT,
    )
      ? value.contextBudgetPercent
      : DEFAULT_CONTEXT_BUDGET_PERCENT,
    toolOutputBudgetTokens: integerInRange(
      value.toolOutputBudgetTokens,
      MIN_TOOL_OUTPUT_BUDGET_TOKENS,
      MAX_TOOL_OUTPUT_BUDGET_TOKENS,
    )
      ? value.toolOutputBudgetTokens
      : DEFAULT_TOOL_OUTPUT_BUDGET_TOKENS,
  };
}

/** Budget token output tool: nilai absolut, dibatasi persen context window bila diketahui. */
export function resolveToolOutputBudgetTokens(
  config: ContextManagerConfig,
  contextWindow: number | null | undefined,
): number {
  if (!contextWindow) return config.toolOutputBudgetTokens;
  return Math.min(config.toolOutputBudgetTokens, Math.floor(contextWindow * config.contextBudgetPercent / 100));
}

/** Read fresh on every call so config changes apply without restarting Pi. */
export function loadContextManagerConfig(customPath?: string): ContextManagerConfig {
  const path = customPath ?? getContextManagerConfigPath();
  if (!existsSync(path)) return DEFAULT_CONTEXT_MANAGER_CONFIG;

  try {
    return parseContextManagerConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_CONTEXT_MANAGER_CONFIG;
  }
}

export async function saveContextManagerConfig(
  config: ContextManagerConfig,
  customPath?: string,
): Promise<void> {
  const path = customPath ?? getContextManagerConfigPath();
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function resetContextManagerConfig(customPath?: string): Promise<void> {
  const path = customPath ?? getContextManagerConfigPath();
  await unlink(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  });
}

export function applyBudgetEnvironmentOverride(config: ContextManagerConfig): ContextManagerConfig {
  const raw = Number.parseInt(process.env.PI_CONTEXT_MANAGER_BUDGET_PERCENT ?? "", 10);
  if (!Number.isFinite(raw)) return config;
  return {
    ...config,
    contextBudgetPercent: Math.max(
      MIN_CONTEXT_BUDGET_PERCENT,
      Math.min(raw, MAX_CONTEXT_BUDGET_PERCENT),
    ),
  };
}
