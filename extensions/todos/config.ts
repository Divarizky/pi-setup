/**
 * Unified Config — hot-reload: every getter reads JSON files fresh per call,
 * so edits apply without /reload.
 * Primary config file: `~/.config/todos/config.json`
 * Fallback config file: `~/.config/task-judge/config.json` (for legacy task-judge settings)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locale } from "./locale.ts";
import {
	DEFAULT_DOC_EXTENSIONS,
	DEFAULT_VALIDATION_PATTERNS,
} from "./judge/judge.ts";
import {
	detectProjectValidationPatterns,
	type ReadProjectFile,
} from "./judge/project-validation.ts";

export type JudgeMode = "warn" | "off" | "enforce";
export type TaskGateMode = "off" | "warn" | "strict";

export interface NestedJudgeConfig {
	enabled?: boolean;
	model?: string;
	timeoutMs?: number;
}

export interface JudgeConfig {
	mode?: JudgeMode | string;
	docExtensions?: string[];
	validationPatterns?: string[];
	nestedJudge?: NestedJudgeConfig;
	taskGateMode?: TaskGateMode | string;
}

export interface TodosConfig {
	/** Content-row budget for the overlay (min 3). */
	maxWidgetLines?: number;
	/** Overlay collapse/expand shortcut key spec, or "off" to disable. */
	collapseKey?: string;
	/** Initial UI language ("en" default, "id" supported). */
	locale?: Locale;
	/** Nested judge config */
	judge?: JudgeConfig;
	/** Flattened judge config fields */
	mode?: JudgeMode | string;
	docExtensions?: string[];
	validationPatterns?: string[];
	nestedJudge?: NestedJudgeConfig;
	taskGateMode?: TaskGateMode | string;
}

export type TaskJudgeConfig = TodosConfig;

export const DEFAULT_MAX_WIDGET_LINES = 12;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";
export const COLLAPSE_KEY_OFF = "off";
export type CollapseKeySpec = string;

export const DEFAULT_NESTED_JUDGE_MODEL = "zenith-router:ag/gemini-3.8-flash";
export const DEFAULT_NESTED_JUDGE_TIMEOUT_MS = 20000;

export interface NestedJudgeSettings {
	enabled: boolean;
	provider: string;
	modelId: string;
	timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Config file I/O
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
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (err) {
		console.warn(`todos: invalid JSON at ${path}, using defaults — ${(err as Error).message}`);
		return {} as T;
	}
}

/**
 * Load unified config: reads `~/.config/todos/config.json`, and if judge settings
 * are absent, cascades to `~/.config/task-judge/config.json`.
 */
export function loadConfig(): TodosConfig {
	const todosConfig = loadJsonConfig<TodosConfig>(configPath("todos"));
	const legacyJudgeConfig = loadJsonConfig<TodosConfig>(configPath("task-judge"));

	return {
		...legacyJudgeConfig,
		...todosConfig,
		judge: {
			...legacyJudgeConfig.judge,
			...todosConfig.judge,
		},
		nestedJudge: {
			...legacyJudgeConfig.nestedJudge,
			...todosConfig.nestedJudge,
			...(todosConfig.judge?.nestedJudge ?? {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Todos Getters
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
// Judge Getters
// ---------------------------------------------------------------------------

export function getJudgeMode(): JudgeMode {
	const config = loadConfig();
	const raw = config.judge?.mode ?? config.mode;
	if (raw === "off") return "off";
	if (raw === "enforce") return "enforce";
	return "warn";
}

export function getTaskGateMode(): TaskGateMode {
	const config = loadConfig();
	const raw = config.judge?.taskGateMode ?? config.taskGateMode;
	if (raw === "off") return "off";
	if (raw === "strict") return "strict";
	return "warn";
}

export function getNestedJudgeSettings(): NestedJudgeSettings {
	const raw = loadConfig().nestedJudge ?? {};
	const spec =
		typeof raw.model === "string" && raw.model.trim()
			? raw.model.trim()
			: DEFAULT_NESTED_JUDGE_MODEL;
	const separator = spec.indexOf(":");
	const provider = separator > 0 ? spec.slice(0, separator) : "";
	const modelId = separator > 0 ? spec.slice(separator + 1) : "";
	const timeoutMs =
		typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
			? raw.timeoutMs
			: DEFAULT_NESTED_JUDGE_TIMEOUT_MS;
	return {
		enabled: raw.enabled === true,
		provider,
		modelId,
		timeoutMs,
	};
}

const TEMPLATES_PATH = fileURLToPath(new URL("./judge/templates.json", import.meta.url));

const PREWALK_FALLBACK =
	"Sebelum mengakhiri sesi, MUST menjalankan validasi yang relevan (tes, linter, atau build) dan melaporkan hasil aktualnya.";

export function readPrewalkTemplate(path: string): string {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			prewalkChecklist?: unknown;
		};
		const value = parsed?.prewalkChecklist;
		return typeof value === "string" && value.trim() ? value : PREWALK_FALLBACK;
	} catch {
		return PREWALK_FALLBACK;
	}
}

export function getPrewalkTemplate(): string {
	return readPrewalkTemplate(TEMPLATES_PATH);
}

export function getEffectiveDocExtensions(): readonly string[] {
	const config = loadConfig();
	const raw = config.judge?.docExtensions ?? config.docExtensions;
	if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
		return raw;
	}
	return DEFAULT_DOC_EXTENSIONS;
}

const readProjectFileUtf8: ReadProjectFile = (path) => readFileSync(path, "utf-8");

export function getEffectiveValidationPatterns(
	cwd: string = process.cwd(),
	readFile: ReadProjectFile = readProjectFileUtf8,
): readonly string[] {
	const config = loadConfig();
	const raw = config.judge?.validationPatterns ?? config.validationPatterns;
	if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
		return raw;
	}
	const detected = detectProjectValidationPatterns(cwd, readFile);
	return [...new Set([...DEFAULT_VALIDATION_PATTERNS, ...detected])];
}

// ---------------------------------------------------------------------------
// Collapse key spec validation
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

export function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	if (base.length === 1 && /^[a-z0-9]$/.test(base)) return true;
	if (SPECIAL_KEYS.has(base)) return true;
	return false;
}

export function resolveCollapseKey(): CollapseKeySpec {
	const config = loadConfig();
	const raw = typeof config.collapseKey === "string" ? config.collapseKey.trim().toLowerCase() : undefined;
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}
