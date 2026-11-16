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
	lastAssistantText?: string;
	structuredWaiting?: boolean;
	reminderCount: number;
	maxRetries?: number;
	totalInterventions?: number;
	maxInterventions?: number;
	activeDelegations?: ReadonlySet<string>;
	activeRequestTaskIds?: ReadonlySet<number>;
	hasActiveUserRequest?: boolean;
	lastFingerprint?: string | null;
	currentFingerprint?: string;
}

export const DEFAULT_REMINDER_MAX_RETRIES = 1;
export const DEFAULT_MAX_INTERVENTIONS = 2;

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
 * Returns `true` when structured waiting is signalled or when the assistant
 * text indicates it stopped to wait for the user.
 * Returns `true` on empty input as well, per the fail-closed rule.
 */
export function isWaitingForUserInput(text: string, structuredWaiting = false): boolean {
	if (structuredWaiting) return true;
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;

	const withoutClosers = trimmed.replace(TRAILING_CLOSERS, "");
	if (QUESTION_ENDING.test(withoutClosers)) return true;

	return WAITING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Extracts explicit worker or workflow ID from a task (never guessing from subject).
 */
export function getTaskDelegationId(task: Task): string | undefined {
	if (typeof task.metadata?.workerId === "string" && task.metadata.workerId.trim()) {
		return task.metadata.workerId.trim();
	}
	if (typeof task.metadata?.workflowId === "string" && task.metadata.workflowId.trim()) {
		return task.metadata.workflowId.trim();
	}
	if (typeof task.metadata?.agentId === "string" && task.metadata.agentId.trim()) {
		return task.metadata.agentId.trim();
	}
	if (typeof task.metadata?.subagentId === "string" && task.metadata.subagentId.trim()) {
		return task.metadata.subagentId.trim();
	}
	if (typeof task.owner === "string" && task.owner.trim()) {
		const raw = task.owner.trim();
		if (raw.startsWith("worker:") || raw.startsWith("workflow:") || raw.startsWith("subagent:")) {
			return raw.replace(/^(worker|workflow|subagent):/, "").trim();
		}
	}
	return undefined;
}

/**
 * Evaluates whether a task is actionable (not waiting on worker/workflow,
 * not waiting on user, and not blocked by unfinished dependencies).
 */
export function isTaskActionable(
	task: Task,
	allTasks: readonly Task[],
	activeDelegations?: ReadonlySet<string>,
): boolean {
	if (task.status !== "pending" && task.status !== "in_progress") {
		return false;
	}

	// 1. Explicit structured waiting on the task
	if (
		task.metadata?.waiting === true ||
		task.metadata?.waitingForUser === true ||
		task.metadata?.waitingFor === "user" ||
		task.metadata?.waitingFor === "worker" ||
		task.metadata?.waitingFor === "workflow" ||
		task.metadata?.waitingFor === "dependency"
	) {
		return false;
	}

	// 2. Unfinished dependencies
	if (task.blockedBy?.length) {
		const isBlocked = task.blockedBy.some((depId) => {
			const depTask = allTasks.find((t) => t.id === depId);
			return !depTask || depTask.status !== "completed";
		});
		if (isBlocked) return false;
	}

	// 3. Waiting on running worker or workflow
	const delegationId = getTaskDelegationId(task) ?? (typeof task.owner === "string" ? task.owner.trim() : undefined);
	if (delegationId && activeDelegations?.has(delegationId)) {
		// If worker is running and results are not marked reviewReady, it is waiting
		if (task.metadata?.reviewReady !== true) {
			return false;
		}
	}

	return true;
}

/**
 * Filters all tasks down to actionable tasks, optionally restricted to tasks
 * touched/adopted in the current request.
 */
export function getActionableTasks(
	tasks: readonly Task[],
	activeDelegations?: ReadonlySet<string>,
	activeRequestTaskIds?: ReadonlySet<number>,
	hasActiveUserRequest = false,
): Task[] {
	let candidates = tasks;
	if (hasActiveUserRequest) {
		candidates = tasks.filter((t) => activeRequestTaskIds?.has(t.id));
	}
	return candidates.filter((t) => isTaskActionable(t, tasks, activeDelegations));
}

/**
 * Deterministic fingerprint of actionable task conditions and request scope.
 */
export function computeTaskFingerprint(tasks: readonly Task[], requestScopeId?: string): string {
	const items = tasks.map((t) => [
		t.id,
		t.status,
		t.subject,
		t.blockedBy ? [...t.blockedBy].sort((a, b) => a - b) : [],
		t.activeForm ?? "",
		t.metadata?.reviewReady ?? false,
	]);
	return JSON.stringify({ scope: requestScopeId ?? "", items });
}

/**
 * Decides whether the assistant should be reminded to finish or update its
 * active todo tasks before ending the work.
 */
export function shouldRemindPendingTodos(params: ShouldRemindParams): boolean {
	const maxRetries = params.maxRetries ?? DEFAULT_REMINDER_MAX_RETRIES;
	if (params.reminderCount >= maxRetries) return false;

	if (
		params.totalInterventions !== undefined &&
		params.maxInterventions !== undefined &&
		params.totalInterventions >= params.maxInterventions
	) {
		return false;
	}

	if (isWaitingForUserInput(params.lastAssistantText ?? "", params.structuredWaiting)) {
		return false;
	}

	const actionable = getActionableTasks(
		params.tasks,
		params.activeDelegations,
		params.activeRequestTaskIds,
		params.hasActiveUserRequest,
	);
	if (actionable.length === 0) return false;

	if (
		params.currentFingerprint &&
		params.lastFingerprint &&
		params.currentFingerprint === params.lastFingerprint
	) {
		return false;
	}

	return true;
}

export function buildReminderMessage(pendingCount: number, inProgressCount: number): string {
	return `Perhatian: Masih terdapat ${inProgressCount} task sedang berjalan dan ${pendingCount} task pending di daftar todo. Selesaikan atau perbarui status task sebelum mengakhiri pekerjaan.`;
}
