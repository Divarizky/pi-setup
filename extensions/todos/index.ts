/**
 * todos — Pi extension. Registers the `todo` tool, `/todos` slash command,
 * `/lang` language switch, and the persistent TodosOverlay widget.
 *
 * Overlay lifecycle: session_start replays the branch into the session's own
 * slot and binds the foreground overlay; session_compact / session_tree
 * re-key and refresh; session_shutdown evicts the slot and disposes the
 * overlay; tool_execution_end refreshes after a successful `todo` call.
 * Config (maxWidgetLines, collapseKey) is read hot per render — no /reload.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { COLLAPSE_KEY_OFF, getConfigLocale, resolveCollapseKey } from "./config.ts";
import { registerLangCommand, setLocale } from "./locale.ts";
import { makeOverlayLoader, prewarmOverlay, type OverlayImporter } from "./loader.ts";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	getRenderState,
	getTodos,
	replaceState,
	replayFromBranch,
	setActiveRenderSession,
	sid,
} from "./state/store.ts";
import { registerTodoTool } from "./tool.ts";
import { registerTodosCommand } from "./command.ts";
import { buildReminderMessage, shouldRemindPendingTodos } from "./state/reminder.ts";
import {
	buildInactivityNudgeMessage,
	DEFAULT_NUDGE_THRESHOLD,
	recordToolExecution,
	shouldSendInactivityNudge,
	type NudgeState,
} from "./state/nudge.ts";
import { TOOL_NAME } from "./types.ts";
import type { TodosOverlay } from "./overlay/widget.ts";

/** pi-core's ExtensionRunner throws this phrase from an invalidated ctx proxy
 * after session replacement/reload. Match the stable substring so genuine
 * replay bugs still propagate instead of being silently swallowed. */
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Text of the last assistant message, or "" when none carries text.
 * An empty result is fail-closed in shouldRemindPendingTodos (no reminder). */
function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string")
			.map((block: { text: string }) => block.text)
			.join("\n");
	}
	return "";
}

export default function (pi: ExtensionAPI, importOverlay: OverlayImporter = () => import("./overlay/widget.ts")) {
	// Initial locale from config (read once at init; /lang switches live).
	setLocale(getConfigLocale());

	let todoOverlay: TodosOverlay | undefined;
	const loadTodoOverlay = makeOverlayLoader(importOverlay);
	let uiCtx: ExtensionUIContext | undefined;
	const uiSessions = new Map<string, ExtensionUIContext>();
	let lifecycleGeneration = 0;
	// Completion reminders sent per session during the current user-initiated run.
	const reminderCounters = new Map<string, number>();
	// Inactivity nudge state per session. An absent slot means the default state.
	const nudgeStates = new Map<string, NudgeState>();

	async function updateTodoOverlay(
		resetCompletedDisplayState = false,
		generation = lifecycleGeneration,
	): Promise<void> {
		const hasVisibleTasks = getRenderState().tasks.some((task) => task.status !== "deleted");
		if (!uiCtx || (!todoOverlay && !hasVisibleTasks)) return;

		const { TodosOverlay } = await loadTodoOverlay();
		if (generation !== lifecycleGeneration || !uiCtx) return;

		todoOverlay ??= new TodosOverlay(collapseKey);
		todoOverlay.setUICtx(uiCtx);
		if (resetCompletedDisplayState) todoOverlay.resetCompletedDisplayState();
		todoOverlay.update();
	}

	registerTodoTool(pi);
	registerTodosCommand(pi);
	registerLangCommand(pi, () => {
		void updateTodoOverlay().catch((e) => {
			console.warn(`[todos] overlay refresh failed after language change: ${formatError(e)}`);
		});
	});

	// Collapse/expand hotkey. Resolved once at factory scope from config
	// (register-once contract: a config change needs /reload to re-bind).
	// The handler closes over `todoOverlay` by reference and re-reads it at
	// fire time. No-op in headless mode or when the widget isn't registered.
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
			handler: (ctx) => {
				if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
				todoOverlay.toggleCollapse();
			},
		});
	}

	// Re-key a session's slot from its branch, then refresh the overlay only
	// when the refreshed session IS the foreground. Shared by session_compact
	// and session_tree. A stale ctx keeps current state — the replacement
	// session's session_start replays it. The render is sid-gated so a child
	// never refreshes the foreground overlay.
	const replayAndRefresh = async (
		ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
	): Promise<void> => {
		let isForeground = false;
		try {
			const id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
			isForeground = id === getActiveRenderSession();
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (isForeground) await updateTodoOverlay(true);
	};

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
			// Every session replays into its OWN data slot (session isolation).
			replaceState(id, replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		if (!ctx.hasUI) return;
		uiSessions.set(id, ctx.ui);
		// First UI-bearing session_start claims the foreground (the interactive
		// launcher, by spawn-ordering) without eagerly loading the overlay.
		if (getActiveRenderSession() === "") setActiveRenderSession(id);
		if (id !== getActiveRenderSession()) return;
		const generation = ++lifecycleGeneration;
		uiCtx = ctx.ui;
		await updateTodoOverlay(true, generation);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		let s: string;
		try {
			s = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			s = "";
		}
		// The shutting-down session's own data slot is always evicted.
		evictSession(s);
		reminderCounters.delete(s);
		nudgeStates.delete(s);
		uiSessions.delete(s);
		// Overlay teardown is sid-gated: only the foreground's own shutdown
		// (or an unknown/stale sid) tears it down and clears the pointer.
		if (s === "" || s === getActiveRenderSession()) {
			lifecycleGeneration++;
			try {
				todoOverlay?.dispose();
			} finally {
				todoOverlay = undefined;
				clearActiveRenderSession();
				uiCtx = undefined;
			}

			// Promote an already-running UI session instead of leaving the
			// ctx-less render pointer orphaned after foreground shutdown.
			if (s !== "") {
				const replacement = uiSessions.entries().next().value as [string, ExtensionUIContext] | undefined;
				if (replacement) {
					const [replacementId, replacementCtx] = replacement;
					setActiveRenderSession(replacementId);
					uiCtx = replacementCtx;
					const generation = ++lifecycleGeneration;
					await updateTodoOverlay(true, generation);
				}
			}
		}
	});

	// Reads getRenderState() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		try {
			await updateTodoOverlay();
		} catch (e) {
			console.warn(`[todos] overlay refresh failed (will retry on next update): ${formatError(e)}`);
		}
	});

	// Evaluate the lazy graph after startup while Pi's boot-time dependency
	// paths are still stable. Loads no widget; stays deferred until a
	// foreground session has visible tasks. unref avoids holding the process.
	prewarmOverlay(loadTodoOverlay);

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});

	// Counts consecutive mutating tool calls per session. Non-blocking: the nudge
	// is queued as a steer message and does not start a turn or alter the result.
	pi.on("tool_result", (event, ctx) => {
		try {
			const id = sid(ctx);
			const hasActiveTodos = getTodos(id).some((t) => t.status === "pending" || t.status === "in_progress");
			const previous = nudgeStates.get(id) ?? { mutationCount: 0, hasActiveTodos: false };
			let state = recordToolExecution({ ...previous, hasActiveTodos }, event.toolName, Boolean(event.isError));
			if (shouldSendInactivityNudge(state, DEFAULT_NUDGE_THRESHOLD)) {
				pi.sendMessage(
					{
						customType: "todos-nudge",
						content: buildInactivityNudgeMessage(state.mutationCount),
						display: true,
					},
					{ deliverAs: "steer" },
				);
				state = { ...state, mutationCount: 0 };
			}
			nudgeStates.set(id, state);
		} catch (e) {
			console.warn(`[todos] inactivity nudge skipped (fail-open): ${formatError(e)}`);
		}
	});

	// A new user prompt starts a fresh reminder budget. Continuations that
	// Pi requests itself are not "user" runs, so they keep counting.
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") reminderCounters.delete(sid(ctx));
	});

	// Fail-open: an error here must never block the agent from settling.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome === "aborted") return;
		try {
			const id = sid(ctx);
			const tasks = getTodos(id);
			if (!tasks.some((t) => t.status === "pending" || t.status === "in_progress")) return;

			const reminderCount = reminderCounters.get(id) ?? 0;
			const lastText = lastAssistantText(event.context.llmMessages);
			if (!shouldRemindPendingTodos({ tasks, lastAssistantText: lastText, reminderCount, maxRetries: 3 })) return;

			reminderCounters.set(id, reminderCount + 1);
			const pendingCount = tasks.filter((t) => t.status === "pending").length;
			const inProgressCount = tasks.filter((t) => t.status === "in_progress").length;
			return {
				// Returned entries replace the proposal, so keep earlier handlers' entries.
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: "todos-reminder",
						content: buildReminderMessage(pendingCount, inProgressCount),
						display: true,
					},
				],
				continue: true,
			};
		} catch (e) {
			console.warn(`[todos] completion reminder skipped (fail-open): ${formatError(e)}`);
			return;
		}
	});
}
