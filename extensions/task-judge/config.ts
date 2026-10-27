import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_DOC_EXTENSIONS,
  DEFAULT_VALIDATION_PATTERNS,
} from "./judge.ts";

export type JudgeMode = "warn" | "off";

export interface TaskJudgeConfig {
  mode?: JudgeMode | string;
  docExtensions?: string[];
  validationPatterns?: string[];
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function defaultConfigDir(): string {
  return join(homedir(), ".config");
}

function resolveConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (!xdg) return defaultConfigDir();
  const expanded = expandTilde(xdg);
  return isAbsolute(expanded) ? expanded : defaultConfigDir();
}

function configPath(name: string, file = "config.json"): string {
  return join(resolveConfigDir(), name, file);
}

function loadJsonConfig<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as T;
    }
    return parsed as T;
  } catch (err) {
    console.warn(
      `task-judge: invalid JSON at ${path}, using defaults — ${(err as Error).message}`,
    );
    return {} as T;
  }
}

/** Read fresh on every call — hot-reload contract. */
export function loadConfig(): TaskJudgeConfig {
  return loadJsonConfig<TaskJudgeConfig>(configPath("task-judge"));
}

export function getJudgeMode(): JudgeMode {
  const raw = loadConfig().mode;
  if (raw === "off") return "off";
  // Default warn; tolak nilai lain seperti "enforce" secara aman dan kembali ke "warn"
  return "warn";
}

export function getEffectiveDocExtensions(): readonly string[] {
  const raw = loadConfig().docExtensions;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return raw;
  }
  return DEFAULT_DOC_EXTENSIONS;
}

export function getEffectiveValidationPatterns(): readonly string[] {
  const raw = loadConfig().validationPatterns;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return raw;
  }
  return DEFAULT_VALIDATION_PATTERNS;
}
