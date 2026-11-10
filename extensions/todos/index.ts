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
	getJudgeState,
	getNudgeState,
	getRenderState,
	getTodos,
	replaceState,
	replayFromBranch,
	resetEnforceRetries,
	resetTurnJudgeState,
	setActiveRenderSession,
	setJudgeState,
	setNudgeState,
	setReminderCount,
	sid,
} from "./core/store.ts";
import { registerTodoTool } from "./tool.ts";
import { registerTodosCommand } from "./command.ts";
import { coordinateSettle } from "./lifecycle/settle-coordinator.ts";
import {
	buildInactivityNudgeMessage,
	DEFAULT_NUDGE_THRESHOLD,
	recordToolExecution,
	shouldSendInactivityNudge,
	type NudgeState,
} from "./lifecycle/nudge.ts";
import {
	extractShellCommand,
	isTrackedEditPath,
	isValidationCommand,
	recordEdit,
	recordValidation,
	resolveValidationSuccess,
} from "./judge/judge.ts";
import { extractText } from "./judge/nested-judge.ts";
import { getEffectiveValidationPatterns } from "./config.ts";
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

	pi.on("agent_start", async (_event, ctx) => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
		try {
			resetTurnJudgeState(sid(ctx));
		} catch {
			// Fail-open
		}
	});

	// Tracks edit paths, validation commands, and consecutive mutating tool calls per session.
	pi.on("tool_result", (event, ctx) => {
		try {
			const id = sid(ctx);

			// 1. Task-Judge tracking
			if (event.toolName === "edit" || event.toolName === "write") {
				const path = (event.input as { path?: unknown })?.path;
				if (!event.isError && typeof path === "string" && isTrackedEditPath(path, ctx.cwd)) {
					setJudgeState(id, recordEdit(getJudgeState(id), path));
				}
			} else {
				const command = extractShellCommand(event.toolName, event.input);
				const patterns = getEffectiveValidationPatterns(ctx.cwd);
				if (command && isValidationCommand(command, patterns)) {
					const output = extractText(event.content);
					setJudgeState(
						id,
						recordValidation(
							getJudgeState(id),
							command,
							resolveValidationSuccess(command, event.isError, output, patterns),
						),
					);
				}
			}

			// 2. Inactivity nudge tracking
			const hasActiveTodos = getTodos(id).some((t) => t.status === "pending" || t.status === "in_progress");
			const previous = getNudgeState(id);
			let nudge = recordToolExecution({ ...previous, hasActiveTodos }, event.toolName, Boolean(event.isError));
			if (shouldSendInactivityNudge(nudge, DEFAULT_NUDGE_THRESHOLD)) {
				pi.sendMessage(
					{
						customType: "todos-nudge",
						content: buildInactivityNudgeMessage(nudge.mutationCount),
						display: true,
					},
					{ deliverAs: "steer" },
				);
				nudge = { ...nudge, mutationCount: 0 };
			}
			setNudgeState(id, nudge);
		} catch (e) {
			console.warn(`[todos] tool_result processing skipped (fail-open): ${formatError(e)}`);
		}
	});

	// A new user prompt starts a fresh reminder & enforce retry budget.
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") {
			try {
				const id = sid(ctx);
				setReminderCount(id, 0);
				resetEnforceRetries(id);
			} catch {
				// Fail-open
			}
		}
	});

	// Unified settle coordinator: Prioritas 1 Code Integrity, Prioritas 2 Pending Tasks.
	pi.on("agent_before_settle", async (event, ctx) => {
		return await coordinateSettle(event, ctx);
	});
}
