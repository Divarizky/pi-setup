/**
 * Pure evaluation of the inactivity nudge for todo tasks.
 *
 * Counts consecutive mutating tool calls made without touching the todo list.
 * No module state and no side effects. The caller owns the state, passes each
 * tool execution through `recordToolExecution`, and decides what to do with the
 * boolean result (for example, inject a non-blocking message). Mirrors the OMP
 * `session/todo-tracker.ts` adoption.
 */

export const MUTATION_TOOLS: readonly string[] = ["edit", "write", "bash", "execute"];

export const DEFAULT_NUDGE_THRESHOLD = 12;

export interface NudgeState {
	mutationCount: number;
	hasActiveTodos: boolean;
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
 * Applies one tool execution to the nudge state. A successful `todo` call resets
 * the counter, a successful mutating call increments it, and any other call
 * returns the state unchanged.
 */
export function recordToolExecution(state: NudgeState, toolName: string, isError = false): NudgeState {
	if (isTodoInteraction(toolName, isError)) {
		return { ...state, mutationCount: 0 };
	}
	if (isMutationTool(toolName, isError)) {
		return { ...state, mutationCount: state.mutationCount + 1 };
	}
	return state;
}

/**
 * Decides whether an inactivity nudge should be sent. Requires active todo
 * tasks and a mutation count that has reached the threshold.
 */
export function shouldSendInactivityNudge(state: NudgeState, threshold = DEFAULT_NUDGE_THRESHOLD): boolean {
	return state.hasActiveTodos === true && state.mutationCount >= threshold;
}

export function buildInactivityNudgeMessage(mutationCount: number): string {
	return `[todo-nudge] Anda telah menjalankan ${mutationCount} operasi mutasi kode tanpa memperbarui daftar todo. Perbarui status task aktif atau tandai task yang telah selesai.`;
}
