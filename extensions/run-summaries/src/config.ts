import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface SummaryConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "medium",
};

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const legacyConfigPath = join(extensionDirectory, "config.private.json");

export function getSummaryConfigPath(): string {
  try {
    return join(getAgentDir(), "run-summaries.config.json");
  } catch {
    return legacyConfigPath;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

export function parseSummaryConfig(value: unknown) {
  if (!isRecord(value)) return DEFAULT_SUMMARY_CONFIG;

  if (
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !isReasoningLevel(value.reasoning)
  ) {
    return DEFAULT_SUMMARY_CONFIG;
  }

  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    reasoning: value.reasoning,
  } satisfies SummaryConfig;
}

export function loadSummaryConfig(customPath?: string) {
  const primaryPath = customPath ?? getSummaryConfigPath();
  try {
    if (existsSync(primaryPath)) {
      return parseSummaryConfig(JSON.parse(readFileSync(primaryPath, "utf8")));
    }
  } catch {
    // fallback to legacy location if primary read fails
  }

  if (!customPath && existsSync(legacyConfigPath)) {
    try {
      return parseSummaryConfig(
        JSON.parse(readFileSync(legacyConfigPath, "utf8")),
      );
    } catch {
      return DEFAULT_SUMMARY_CONFIG;
    }
  }

  return DEFAULT_SUMMARY_CONFIG;
}

export async function saveSummaryConfig(
  config: SummaryConfig,
  signal?: AbortSignal,
  customPath?: string,
) {
  const targetPath = customPath ?? getSummaryConfigPath();
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const timeoutSignal = AbortSignal.timeout(5_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      signal: combinedSignal,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
