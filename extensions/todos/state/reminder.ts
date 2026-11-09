/**
 * Pure evaluation of the completion reminder for todo tasks.
 *
 * No module state and no side effects. The caller owns the reminder counter
 * and decides what to do with the boolean result (for example, queue a
 * follow-up message). Mirrors the OMP `session/todo-tracker.ts` adoption.
 *
 * Fail-closed rule: when it is unclear whether the assistant is waiting for
 * user input, `isWaitingForUserInput` returns `true` and the reminder is
 * suppressed. A missed reminder is cheaper than a continuation that interrupts
 * the user.
 */

import type { Task } from "../types.ts";

export interface ShouldRemindParams {
	tasks: readonly Task[];
	lastAssistantText: string;
	reminderCount: number;
	maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;

// Trailing characters that may close a sentence after the question mark,
// such as markdown emphasis, quotes, or closing brackets.
const TRAILING_CLOSERS = /[\s*_`"'”’)\]]+$/;

const QUESTION_ENDING = /\?$/;

const WAITING_PATTERNS: readonly RegExp[] = [
	// Indonesian
	/\bbagaimana menurut (anda|kamu|mas|bapak|ibu)\b/i,
	/\bapakah (anda|kamu) (setuju|ingin|mau|berkenan)\b/i,
	/\bapakah boleh\b/i,
	/\bapakah (saya|kami) (perlu|lanjut|lanjutkan|harus)\b/i,
	/\bmohon konfirmasi\b/i,
	/\bsilakan pilih\b/i,
	/\bpilih salah satu\b/i,
	/\blanjut atau\b/i,
	/\bmau saya lanjutkan\b/i,
	/\bmenunggu (konfirmasi|jawaban|persetujuan|input|balasan)\b/i,
	// English
	/\bwould you like\b/i,
	/\bshould i (proceed|continue|go ahead)\b/i,
	/\bshall i\b/i,
	/\bplease confirm\b/i,
	/\bcan you confirm\b/i,
	/\bdo you want\b/i,
	/\bwhich option\b/i,
	/\bplease (choose|select|pick)\b/i,
	/\bwaiting for\b/i,
];

/**
 * Returns `true` when the assistant text indicates it stopped to wait for the
 * user. Returns `true` on empty input as well, per the fail-closed rule.
 */
export function isWaitingForUserInput(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;

	const withoutClosers = trimmed.replace(TRAILING_CLOSERS, "");
	if (QUESTION_ENDING.test(withoutClosers)) return true;

	return WAITING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Decides whether the assistant should be reminded to finish or update its
 * active todo tasks before ending the work.
 */
export function shouldRemindPendingTodos(params: ShouldRemindParams): boolean {
	const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
	if (params.reminderCount >= maxRetries) return false;

	const hasActiveTask = params.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
	if (!hasActiveTask) return false;

	return !isWaitingForUserInput(params.lastAssistantText);
}

export function buildReminderMessage(pendingCount: number, inProgressCount: number): string {
	return `Perhatian: Masih terdapat ${inProgressCount} task sedang berjalan dan ${pendingCount} task pending di daftar todo. Selesaikan atau perbarui status task sebelum mengakhiri pekerjaan.`;
}
