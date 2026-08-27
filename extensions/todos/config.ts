/**
 * Config — hot-reload: every getter reads the JSON file fresh per call, so a
 * config edit applies without /reload. Config file: `~/.config/todos/config.json`
 * (XDG-aware, legacy fallback to the same path under `~/.config`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Locale } from "./locale.ts";

export interface TodosConfig {
  /** Content-row budget for the overlay (min 3). */
  maxWidgetLines?: number;
  /** Overlay collapse/expand shortcut key spec, or "off" to disable. */
  collapseKey?: string;
  /** Initial UI language ("en" default, "id" supported). */
  locale?: Locale;
}

export const DEFAULT_MAX_WIDGET_LINES = 12;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";
export const COLLAPSE_KEY_OFF = "off";
export type CollapseKeySpec = string;

// ---------------------------------------------------------------------------
// Config file I/O (trimmed from @juicesharp/rpiv-config, MIT)
// ---------------------------------------------------------------------------

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
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {} as T;
    return parsed as T;
  } catch (err) {
    console.warn(
      `todos: invalid JSON at ${path}, using defaults — ${(err as Error).message}`,
    );
    return {} as T;
  }
}

/** Read fresh on every call — hot-reload contract. */
export function loadConfig(): TodosConfig {
  return loadJsonConfig<TodosConfig>(configPath("todos"));
}

// ---------------------------------------------------------------------------
// Getters — ALL read fresh per call (no cache)
// ---------------------------------------------------------------------------

export function getMaxWidgetLines(): number {
  const config = loadConfig();
  const lines = config.maxWidgetLines;
  if (typeof lines !== "number" || lines < 3) return DEFAULT_MAX_WIDGET_LINES;
  return lines;
}

export function getConfigLocale(): Locale {
  return loadConfig().locale === "id" ? "id" : "en";
}

// ---------------------------------------------------------------------------
// Collapse key spec validation (port of rpiv-todo config.ts)
// ---------------------------------------------------------------------------

const SPECIAL_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Validate a key spec against pi-tui's KeyId grammar. */
export function isValidCollapseKeySpec(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++"))
    return false;
  const parts = spec.split("+");
  const base = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length !== new Set(modifiers).size) return false;
  if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
  return base.length === 1
    ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base)
    : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(): CollapseKeySpec {
  const config = loadConfig();
  const raw =
    typeof config.collapseKey === "string"
      ? config.collapseKey.trim().toLowerCase()
      : undefined;
  if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
  if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
  return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}
