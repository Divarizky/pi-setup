/**
 * Pure evaluation of the inactivity nudge for todo tasks.
 *
 * Counts consecutive mutating tool calls made without touching the todo list.
 * No module state and no side effects. The caller owns the state, passes each
 * tool execution through `recordToolExecution`, and decides what to do with the
 * boolean result (for example, inject a non-blocking message). Mirrors the OMP
 * `session/todo-tracker.ts` adoption.
 */

import {
	DEFAULT_VALIDATION_PATTERNS,
	extractShellCommand,
	isValidationCommand,
} from "../judge/judge.ts";

export const MUTATION_TOOLS: readonly string[] = ["edit", "write", "bash", "execute"];

export const DEFAULT_NUDGE_THRESHOLD = 12;
export const DEFAULT_MAX_NUDGES_PER_REQUEST = 2;

export interface NudgeState {
	mutationCount: number;
	hasActiveTodos: boolean;
}

export interface RecordToolOptions {
	isError?: boolean;
	input?: unknown;
	action?: string;
	changed?: boolean;
	validationPatterns?: readonly string[];
}

export interface ShouldNudgeOptions {
	threshold?: number;
	maxPerRequest?: number;
	nudgesInRequest?: number;
	currentFingerprint?: string;
	lastFingerprint?: string | null;
}

const READ_ONLY_BASE_COMMANDS = new Set([
	"ls", "dir", "cat", "head", "tail", "grep", "rg", "find", "pwd", "which", "whereis",
	"type", "echo", "printf", "true", "false", "stat", "file", "diff", "cmp", "wc",
	"cut", "sort", "uniq", "column", "less", "more", "tree", "env", "printenv",
	"whoami", "id", "uname", "ps", "top", "df", "du", "uptime",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "branch", "show", "rev-parse", "remote", "tag", "describe",
	"shortlog", "config", "check-ref-format", "ls-files", "ls-tree", "cat-file", "blame",
]);

/**
 * Checks whether a shell command is purely read-only (inspecting repo/state without mutations).
 */
export function isReadOnlyShellCommand(command: string): boolean {
	if (typeof command !== "string" || !command.trim()) return true;
	const trimmed = command.trim();

	// Output redirection to a file (> or >>, but not /dev/null) is a file mutation
	if (/>\s*(?!\/dev\/null)\S+/.test(trimmed)) {
		return false;
	}

	// Split compound commands by &&, ||, ;, |
	const segments = trimmed.split(/&&|\|\||;|\|/);
	for (let seg of segments) {
		seg = seg.trim();
		if (!seg) continue;
		const tokens = seg.split(/\s+/).filter(Boolean);
		let cmdIdx = 0;
		// Skip leading env assignments like VAR=1 cmd
		while (cmdIdx < tokens.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tokens[cmdIdx]!)) {
			cmdIdx++;
		}
		if (cmdIdx >= tokens.length) continue;
		const base = tokens[cmdIdx]!.toLowerCase().replace(/^.*\//, "");

		if (READ_ONLY_BASE_COMMANDS.has(base)) {
			// In-place sed/perl/awk is a mutation
			if (base === "sed" || base === "perl" || base === "awk") {
				if (tokens.slice(cmdIdx + 1).some((arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place"))) {
					return false;
				}
			}
			continue;
		}

		if (base === "git") {
			const sub = tokens[cmdIdx + 1]?.toLowerCase();
			if (!sub || sub === "--version" || sub === "-v") continue;
			if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) continue;
			return false;
		}

		if (
			base === "node" ||
			base === "npm" ||
			base === "pnpm" ||
			base === "yarn" ||
			base === "bun" ||
			base === "python" ||
			base === "python3" ||
			base === "go" ||
			base === "cargo"
		) {
			const sub = tokens[cmdIdx + 1]?.toLowerCase();
			if (sub === "-v" || sub === "--version" || sub === "-version" || sub === "version") {
				continue;
			}
			return false;
		}

		return false;
	}
	return true;
}

/**
 * Returns `true` when the tool is a mutating tool and the call did not fail.
 */
export function isMutationTool(toolName: string, isError = false): boolean {
	return !isError && MUTATION_TOOLS.includes(toolName);
}

/**
 * Returns `true` when the call is a successful interaction with the todo list.
 */
export function isTodoInteraction(toolName: string, isError = false): boolean {
	return toolName === "todo" && !isError;
}

/**
 * Applies one tool execution to the nudge state.
 * Only real progress resets the mutation count; read-only todo list/get
 * and no-op updates do not reset. Read-only and validation shell commands
 * do not count as mutations.
 */
export function recordToolExecution(
	state: NudgeState,
	toolName: string,
	isErrorOrOptions: boolean | RecordToolOptions = false,
	maybeOptions?: RecordToolOptions,
): NudgeState {
	const isError =
		typeof isErrorOrOptions === "boolean"
			? isErrorOrOptions
			: Boolean(isErrorOrOptions?.isError);
	const opts: RecordToolOptions =
		typeof isErrorOrOptions === "object"
			? isErrorOrOptions
			: (maybeOptions ?? {});

	if (toolName === "todo") {
		if (isError) return state;
		// Check for real progress vs read-only / no-op
		if (opts.action === "list" || opts.action === "get") {
			return state;
		}
		if (opts.action === "update" && opts.changed === false) {
			return state;
		}
		return { ...state, mutationCount: 0 };
	}

	if (isError) return state;

	if (toolName === "edit" || toolName === "write") {
		return { ...state, mutationCount: state.mutationCount + 1 };
	}

	if (toolName === "bash" || toolName === "execute") {
		if (opts.input !== undefined) {
			const cmd = extractShellCommand(toolName, opts.input);
			if (cmd) {
				const patterns = opts.validationPatterns ?? DEFAULT_VALIDATION_PATTERNS;
				if (isValidationCommand(cmd, patterns)) {
					return state;
				}
				if (isReadOnlyShellCommand(cmd)) {
					return state;
				}
			} else {
				// Non-shell runtime without command
				return state;
			}
		}
		// If input is omitted (legacy unit test) or command is mutating
		return { ...state, mutationCount: state.mutationCount + 1 };
	}

	return state;
}

/**
 * Decides whether an inactivity nudge should be sent. Requires active todo
 * tasks and a mutation count that has reached the threshold, bounded by
 * maxPerRequest and deduplication.
 */
export function shouldSendInactivityNudge(
	state: NudgeState,
	thresholdOrOptions: number | ShouldNudgeOptions = DEFAULT_NUDGE_THRESHOLD,
): boolean {
	const threshold =
		typeof thresholdOrOptions === "number"
			? thresholdOrOptions
			: (thresholdOrOptions.threshold ?? DEFAULT_NUDGE_THRESHOLD);
	const maxPerRequest =
		typeof thresholdOrOptions === "object"
			? (thresholdOrOptions.maxPerRequest ?? DEFAULT_MAX_NUDGES_PER_REQUEST)
			: undefined;
	const nudgesInRequest =
		typeof thresholdOrOptions === "object"
			? (thresholdOrOptions.nudgesInRequest ?? 0)
			: 0;

	if (state.hasActiveTodos !== true || state.mutationCount < threshold) {
		return false;
	}

	if (maxPerRequest !== undefined && nudgesInRequest >= maxPerRequest) {
		return false;
	}

	if (typeof thresholdOrOptions === "object") {
		if (
			thresholdOrOptions.currentFingerprint &&
			thresholdOrOptions.lastFingerprint &&
			thresholdOrOptions.currentFingerprint === thresholdOrOptions.lastFingerprint
		) {
			return false;
		}
	}

	return true;
}

export function buildInactivityNudgeMessage(mutationCount: number): string {
	return `[todo-nudge] Anda telah menjalankan ${mutationCount} operasi mutasi kode tanpa memperbarui daftar todo. Perbarui status task aktif atau tandai task yang telah selesai.`;
}
