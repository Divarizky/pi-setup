/**
 * Per-session live state + branch replay.
 *
 * The `sessions` Map is the single mutation seam — only `commitState` /
 * `replaceState` / `evictSession` write it; the reducer stays pure.
 *
 * Persistence is the session branch itself (rpiv-todo's approach): on
 * session lifecycle events, `replayFromBranch` walks the branch for the LAST
 * `todo` toolResult whose `details` matches `TaskDetails` (last-write-wins)
 * and reconstructs state. No file I/O, survives /reload and compaction.
 */

import type { Task, TaskDetails, TaskStatus } from "../types.ts";
import { createInitialState, type TaskJudgeState } from "../judge/judge.ts";
import type { NudgeState } from "../lifecycle/nudge.ts";

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export interface SessionState extends TaskState {
	judgeState: TaskJudgeState;
	enforceRetries: number;
	reminderCount: number;
	interventionCount: number;
	lastRemindedFingerprint: string | null;
	lastNudgeFingerprint: string | null;
	nudgesInRequest: number;
	nudgeState: NudgeState;
	activeRequestId: string;
	hasActiveUserRequest: boolean;
	activeRequestTaskIds: Set<number>;
	activeDelegations: Set<string>;
	settledDelegations: Map<string, { status: string; resultPreview?: string; error?: string }>;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

function freshSessionState(): SessionState {
	return {
		tasks: [...EMPTY_STATE.tasks],
		nextId: EMPTY_STATE.nextId,
		judgeState: createInitialState(),
		enforceRetries: 0,
		reminderCount: 0,
		interventionCount: 0,
		lastRemindedFingerprint: null,
		lastNudgeFingerprint: null,
		nudgesInRequest: 0,
		nudgeState: { mutationCount: 0, hasActiveTodos: false },
		activeRequestId: "req-init",
		hasActiveUserRequest: false,
		activeRequestTaskIds: new Set<number>(),
		activeDelegations: new Set<string>(),
		settledDelegations: new Map(),
	};
}

const sessions = new Map<string, SessionState>();

/**
 * Ctx-less render pointer: which slot do the ctx-free readers (the overlay's
 * render, the tool's `renderCall`) render? Set when the first UI session
 * claims the foreground.
 */
let activeRenderSession = "";

/** Session-id extractor. Structural ctx type (no Pi-runtime import). */
export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

/** Get-or-read a session's slot: the committed slot by identity, or a fresh
 * SessionState copy when the slot is absent. */
function slotFor(sessionId: string): SessionState {
	let slot = sessions.get(sessionId);
	if (!slot) {
		slot = freshSessionState();
		if (sessionId) {
			sessions.set(sessionId, slot);
		}
	}
	return slot;
}

export function getTodos(sessionId: string): readonly Task[] {
	return slotFor(sessionId).tasks;
}

export function getNextId(sessionId: string): number {
	return slotFor(sessionId).nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
	const slot = slotFor(sessionId);
	return { tasks: slot.tasks, nextId: slot.nextId };
}

/** Replay seam — lifecycle handlers call this after `replayFromBranch`. */
export function replaceState(sessionId: string, next: TaskState): void {
	const slot = slotFor(sessionId);
	slot.tasks = [...next.tasks];
	slot.nextId = next.nextId;
}

/** Post-reducer commit seam — tool `execute()` publishes new canonical state. */
export function commitState(sessionId: string, next: TaskState): void {
	const slot = slotFor(sessionId);
	slot.tasks = [...next.tasks];
	slot.nextId = next.nextId;
}

export function getJudgeState(sessionId: string): TaskJudgeState {
	return slotFor(sessionId).judgeState;
}

export function setJudgeState(sessionId: string, next: TaskJudgeState): void {
	slotFor(sessionId).judgeState = next;
}

export function resetTurnJudgeState(sessionId: string): void {
	slotFor(sessionId).judgeState = createInitialState();
}

export function getEnforceRetries(sessionId: string): number {
	return slotFor(sessionId).enforceRetries;
}

export function incrementEnforceRetries(sessionId: string): number {
	const slot = slotFor(sessionId);
	slot.enforceRetries += 1;
	return slot.enforceRetries;
}

export function resetEnforceRetries(sessionId: string): void {
	slotFor(sessionId).enforceRetries = 0;
}

export function getReminderCount(sessionId: string): number {
	return slotFor(sessionId).reminderCount;
}

export function setReminderCount(sessionId: string, count: number): void {
	slotFor(sessionId).reminderCount = count;
}

export function getInterventionCount(sessionId: string): number {
	return slotFor(sessionId).interventionCount;
}

export function incrementInterventions(sessionId: string): number {
	const slot = slotFor(sessionId);
	slot.interventionCount += 1;
	return slot.interventionCount;
}

export function resetInterventions(sessionId: string): void {
	slotFor(sessionId).interventionCount = 0;
}

export function getLastRemindedFingerprint(sessionId: string): string | null {
	return slotFor(sessionId).lastRemindedFingerprint;
}

export function setLastRemindedFingerprint(sessionId: string, fp: string | null): void {
	slotFor(sessionId).lastRemindedFingerprint = fp;
}

export function getLastNudgeFingerprint(sessionId: string): string | null {
	return slotFor(sessionId).lastNudgeFingerprint;
}

export function setLastNudgeFingerprint(sessionId: string, fp: string | null): void {
	slotFor(sessionId).lastNudgeFingerprint = fp;
}

export function getNudgesInRequest(sessionId: string): number {
	return slotFor(sessionId).nudgesInRequest;
}

export function incrementNudgesInRequest(sessionId: string): number {
	const slot = slotFor(sessionId);
	slot.nudgesInRequest += 1;
	return slot.nudgesInRequest;
}

export function resetNudgesInRequest(sessionId: string): void {
	slotFor(sessionId).nudgesInRequest = 0;
}

let requestSeq = 0;

export function startNewUserRequest(sessionId: string, prompt = ""): void {
	const slot = slotFor(sessionId);
	slot.enforceRetries = 0;
	slot.reminderCount = 0;
	slot.interventionCount = 0;
	slot.nudgesInRequest = 0;
	slot.lastRemindedFingerprint = null;
	slot.lastNudgeFingerprint = null;
	slot.activeRequestId = `req-${++requestSeq}-${Date.now()}`;
	slot.hasActiveUserRequest = true;
	slot.activeRequestTaskIds = new Set<number>();

	// If prompt explicitly refers to task ids or asks to continue/work on tasks, adopt them
	if (typeof prompt === "string" && prompt.trim()) {
		const lower = prompt.toLowerCase();
		if (
			/\b(lanjut|lanjutkan|teruskan|continue|proceed|go ahead|resume|selesaikan|kerjakan\s+todo|todos?)\b/i.test(
				lower,
			)
		) {
			for (const t of slot.tasks) {
				slot.activeRequestTaskIds.add(t.id);
			}
		} else {
			const hashMatches = prompt.matchAll(/#(\d+)\b/g);
			for (const m of hashMatches) {
				const id = Number(m[1]);
				if (Number.isSafeInteger(id)) slot.activeRequestTaskIds.add(id);
			}
			const taskMatches = prompt.matchAll(/\btask\s+(\d+)\b/gi);
			for (const m of taskMatches) {
				const id = Number(m[1]);
				if (Number.isSafeInteger(id)) slot.activeRequestTaskIds.add(id);
			}
		}
	}
}

export function hasActiveUserRequest(sessionId: string): boolean {
	return slotFor(sessionId).hasActiveUserRequest;
}

export function getActiveRequestId(sessionId: string): string {
	return slotFor(sessionId).activeRequestId;
}

export function touchTaskInRequest(sessionId: string, taskId: number): void {
	slotFor(sessionId).activeRequestTaskIds.add(taskId);
}

export function getActiveRequestTaskIds(sessionId: string): ReadonlySet<number> {
	return slotFor(sessionId).activeRequestTaskIds;
}

export function getActiveDelegations(sessionId: string): ReadonlySet<string> {
	return slotFor(sessionId).activeDelegations;
}

export function startDelegation(sessionId: string, delegationId: string): void {
	if (!delegationId) return;
	const targetSessions = sessionId ? [slotFor(sessionId)] : Array.from(sessions.values());
	for (const slot of targetSessions) {
		slot.activeDelegations.add(delegationId);
	}
}

export function settleDelegation(
	sessionId: string,
	delegationId: string,
	info: { status: string; resultPreview?: string; error?: string },
): void {
	if (!delegationId) return;
	const targetSessions = sessionId ? [slotFor(sessionId)] : Array.from(sessions.values());
	for (const slot of targetSessions) {
		slot.activeDelegations.delete(delegationId);
		slot.settledDelegations.set(delegationId, info);

		// Update matching tasks to review ready
		const tasks = slot.tasks;
		let changed = false;
		for (const t of tasks) {
			const isOwner =
				t.owner === delegationId ||
				t.owner === `worker:${delegationId}` ||
				t.owner === `workflow:${delegationId}`;
			const isMeta =
				t.metadata?.workerId === delegationId ||
				t.metadata?.workflowId === delegationId ||
				t.metadata?.agentId === delegationId ||
				t.metadata?.subagentId === delegationId;
			if (isOwner || isMeta) {
				t.metadata = {
					...(t.metadata ?? {}),
					reviewReady: true,
					delegationStatus: info.status,
					delegationResult: info.resultPreview,
					delegationError: info.error,
				};
				changed = true;
			}
		}
		if (changed) {
			slot.tasks = [...tasks];
		}
	}
}

export function getNudgeState(sessionId: string): NudgeState {
	return slotFor(sessionId).nudgeState;
}

export function setNudgeState(sessionId: string, nudge: NudgeState): void {
	slotFor(sessionId).nudgeState = nudge;
}

/** Drop a session's slot on `session_shutdown`. */
export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Ctx-less render reader: the foreground slot, or a fresh EMPTY_STATE copy. */
export function getRenderState(): TaskState {
	return slotFor(activeRenderSession);
}

/** Set the ctx-less render pointer when the first UI session claims foreground. */
export function setActiveRenderSession(sessionId: string): void {
	activeRenderSession = sessionId;
}

export function getActiveRenderSession(): string {
	return activeRenderSession;
}

/** Foreground teardown — reset pointer so the next hasUI session reclaims it. */
export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}

/** Test-setup reset. */
export function __resetState(): void {
	sessions.clear();
	activeRenderSession = "";
}

// ---------------------------------------------------------------------------
// Branch replay
// ---------------------------------------------------------------------------

/** Discriminator for `details` envelopes that match the persisted TaskDetails
 * shape. Branch entries from older or corrupt sessions are skipped silently. */
const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress", "completed", "deleted"]);

function isPersistedTask(value: unknown): value is Task {
	if (!value || typeof value !== "object") return false;
	const task = value as Record<string, unknown>;
	if (!Number.isSafeInteger(task.id) || (task.id as number) < 1) return false;
	if (typeof task.subject !== "string" || !TASK_STATUSES.has(task.status as TaskStatus)) return false;
	if (task.description !== undefined && typeof task.description !== "string") return false;
	if (task.activeForm !== undefined && typeof task.activeForm !== "string") return false;
	if (task.owner !== undefined && typeof task.owner !== "string") return false;
	if (
		task.metadata !== undefined &&
		(!task.metadata || typeof task.metadata !== "object" || Array.isArray(task.metadata))
	)
		return false;
	if (task.blockedBy !== undefined) {
		if (!Array.isArray(task.blockedBy) || !task.blockedBy.every((id) => Number.isSafeInteger(id) && id >= 1)) return false;
	}
	return true;
}

export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!Number.isSafeInteger(v.nextId) || (v.nextId as number) < 1 || !Array.isArray(v.tasks)) return false;
	const tasks = v.tasks as unknown[];
	const ids = new Set<number>();
	for (const task of tasks) {
		if (!isPersistedTask(task)) return false;
		const id = (task as Task).id;
		if (ids.has(id)) return false;
		ids.add(id);
	}
	if (tasks.some((task) => (task as Task).id >= (v.nextId as number))) return false;
	for (const task of tasks as Task[]) {
		if (task.blockedBy?.some((dep) => dep === task.id || !ids.has(dep))) return false;
	}
	return true;
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches wins. No matching
 * entry → EMPTY_STATE. Pure of module state.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		result = {
			tasks: msg.details.tasks.map((t) => ({
				...t,
				...(t.blockedBy ? { blockedBy: [...t.blockedBy] } : {}),
				...(t.metadata ? { metadata: { ...t.metadata } } : {}),
			})),
			nextId: msg.details.nextId,
		};
	}
	return result;
}
