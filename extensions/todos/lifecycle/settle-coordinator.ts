/**
 * Unified Settle Coordinator — orchestrates agent_before_settle decisions.
 * Hierarchical evaluation:
 *   1. Code Integrity Gate (judge unverified edits)
 *   2. Pending Task Gate (remind uncompleted tasks)
 */

import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	getEffectiveDocExtensions,
	getEffectiveValidationPatterns,
	getJudgeMode,
	getNestedJudgeSettings,
	getPrewalkTemplate,
	getReminderConfig,
} from "../config.ts";
import {
	evaluateRun,
	type TaskJudgeState,
} from "../judge/judge.ts";
import { appendJudgeLog } from "../judge/logger.ts";
import {
	type CompletionLike,
	extractText,
	runNestedJudge,
} from "../judge/nested-judge.ts";
import {
	buildReminderMessage,
	computeTaskFingerprint,
	getActionableTasks,
	shouldRemindPendingTodos,
} from "./reminder.ts";
import {
	getActiveDelegations,
	getActiveRequestId,
	getActiveRequestTaskIds,
	getEnforceRetries,
	getInterventionCount,
	getJudgeState,
	getLastRemindedFingerprint,
	getReminderCount,
	getTodos,
	hasActiveUserRequest,
	incrementEnforceRetries,
	incrementInterventions,
	setLastRemindedFingerprint,
	setReminderCount,
	sid,
} from "../core/store.ts";

export const ENFORCE_MAX_RETRIES = 2;
export const REMINDER_MAX_RETRIES = 1;

export function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant") continue;
		return extractText(m.content);
	}
	return "";
}

export function detectStructuredWaiting(event: AgentBeforeSettleEvent): boolean {
	if (Array.isArray(event.entries)) {
		for (const entry of event.entries) {
			const e = entry as unknown as Record<string, unknown>;
			if (e.customType === "needs-decision" || e.customType === "ask_question") {
				return true;
			}
			if (typeof e.content === "string" && e.content.includes("needs-decision")) {
				return true;
			}
		}
	}
	const messages = event.context?.llmMessages;
	if (Array.isArray(messages)) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as Record<string, unknown>;
			if (m?.role !== "assistant") continue;
			const toolCalls = m.toolCalls as Array<{ name?: string }> | undefined;
			if (Array.isArray(toolCalls)) {
				if (toolCalls.some((tc) => tc?.name === "ask_question" || tc?.name === "ask-user")) {
					return true;
				}
			}
			const text = extractText(m.content);
			if (text.includes("needs-decision")) {
				return true;
			}
			break;
		}
	}
	return false;
}

async function judgeNested(
	state: TaskJudgeState,
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
) {
	try {
		return await runJudgeNested(state, event, ctx);
	} catch (err) {
		return {
			verdict: "tidak_diketahui" as const,
			reason: (err as Error)?.message ?? "error",
			model: "",
			elapsedMs: 0,
			timedOut: false,
		};
	}
}

async function runJudgeNested(
	state: TaskJudgeState,
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
) {
	const settings = getNestedJudgeSettings();
	if (!settings.enabled) return undefined;
	const model = ctx.modelRegistry?.find?.(settings.provider, settings.modelId);
	const label = `${settings.provider}:${settings.modelId}`;
	if (!model) {
		return {
			verdict: "tidak_diketahui" as const,
			reason: "model_not_found",
			model: label,
			elapsedMs: 0,
			timedOut: false,
		};
	}
	const editedPaths = [...new Set(state.edits.map((e) => e.path))];
	const validationCommands = state.validations.map((v) => v.command);
	const lastText = lastAssistantText(event.context.llmMessages);
	const result = await runNestedJudge(
		{ editedPaths, validationCommands, lastAssistantText: lastText },
		(prompt, signal) =>
			ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				{ signal },
			) as Promise<CompletionLike>,
		settings.timeoutMs,
		ctx.signal,
	);
	return { ...result, model: label };
}

export async function coordinateSettle(
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
): Promise<AgentBeforeSettleEventResult | void> {
	if (event.outcome === "aborted") return;

	let id = "";
	try {
		// Do not intercept child subagents
		const header = ctx.sessionManager?.getHeader?.();
		if (header?.parentSession) return;
		id = sid(ctx);
	} catch (e) {
		console.warn(`[todos] settle coordinator session lookup failed (fail-open): ${(e as Error).message}`);
		return;
	}

	const reminderConfig = getReminderConfig();
	const maxInterventions = reminderConfig.maxInterventions ?? 2;
	const maxReminderContinuations = reminderConfig.maxContinuations ?? 1;
	const currentInterventions = getInterventionCount(id);

	// -------------------------------------------------------------------------
	// 1. Code Integrity Gate (task-judge)
	// -------------------------------------------------------------------------
	try {
		const mode = getJudgeMode();
		const docExtensions = getEffectiveDocExtensions();
		const validationPatterns = getEffectiveValidationPatterns(ctx.cwd);
		const judgeState = getJudgeState(id);

		const evaluation = evaluateRun(judgeState, {
			docExtensions,
			validationPatterns,
		});

		let nestedJudge: Awaited<ReturnType<typeof judgeNested>> | undefined;
		if (evaluation.decision === "tidak_terverifikasi" && mode !== "off") {
			nestedJudge = await judgeNested(judgeState, event, ctx);
		}

		appendJudgeLog({
			timestamp: new Date().toISOString(),
			sessionId: id,
			decision: evaluation.decision,
			editCount: evaluation.editCount,
			hasSuccessfulValidation: evaluation.hasSuccessfulValidation,
			mode,
			nestedJudge,
		});

		if (mode !== "off" && evaluation.decision === "tidak_terverifikasi") {
			if (mode === "enforce") {
				const used = getEnforceRetries(id);
				if (used >= ENFORCE_MAX_RETRIES || currentInterventions >= maxInterventions) {
					ctx.ui?.notify?.(
						"Batas retry enforce task-judge tercapai; sesi diselesaikan tanpa validasi sukses.",
						"warning",
					);
				} else {
					incrementEnforceRetries(id);
					incrementInterventions(id);
					ctx.ui?.notify?.(
						"Penyelesaian ditolak task-judge (mode enforce): file diedit tanpa validasi sukses setelah edit terakhir.",
						"error",
					);
					const checklistText = getPrewalkTemplate();
					const enforcementMessage = `Peringatan task-judge (Mode Enforce): Terdapat modifikasi berkas tanpa perintah validasi yang sukses setelah edit terakhir.\n\n${checklistText}`;
					return {
						entries: [
							...(event.entries ?? []),
							{
								type: "custom_message",
								customType: "task-judge-enforcement",
								content: enforcementMessage,
								display: true,
							},
						],
						continue: true,
					};
				}
			} else {
				// mode === "warn"
				ctx.ui?.notify?.(
					"Peringatan task-judge: file diedit tanpa perintah validasi yang sukses setelah edit terakhir.",
					"warning",
				);
			}
		}
	} catch (err) {
		console.warn(`[todos] judge settle coordinator error (fail-closed): ${(err as Error).message}`);
	}

	// -------------------------------------------------------------------------
	// 2. Pending Task Gate (todos reminder)
	// -------------------------------------------------------------------------
	try {
		const updatedInterventions = getInterventionCount(id);
		if (updatedInterventions >= maxInterventions) {
			return;
		}

		const tasks = getTodos(id);
		const activeDelegations = getActiveDelegations(id);
		const activeRequestTaskIds = getActiveRequestTaskIds(id);
		const isUserReqActive = hasActiveUserRequest(id);
		const actionableTasks = getActionableTasks(tasks, activeDelegations, activeRequestTaskIds, isUserReqActive);

		if (actionableTasks.length > 0) {
			const reminderCount = getReminderCount(id);
			const lastText = lastAssistantText(event.context.llmMessages);
			const structuredWaiting = detectStructuredWaiting(event);
			const currentFingerprint = computeTaskFingerprint(actionableTasks, getActiveRequestId(id));
			const lastFingerprint = getLastRemindedFingerprint(id);

			if (
				shouldRemindPendingTodos({
					tasks,
					lastAssistantText: lastText,
					structuredWaiting,
					reminderCount,
					maxRetries: maxReminderContinuations,
					totalInterventions: updatedInterventions,
					maxInterventions,
					activeDelegations,
					activeRequestTaskIds,
					hasActiveUserRequest: isUserReqActive,
					lastFingerprint,
					currentFingerprint,
				})
			) {
				setReminderCount(id, reminderCount + 1);
				incrementInterventions(id);
				setLastRemindedFingerprint(id, currentFingerprint);

				const pendingCount = actionableTasks.filter((t) => t.status === "pending").length;
				const inProgressCount = actionableTasks.filter((t) => t.status === "in_progress").length;
				return {
					entries: [
						...(event.entries ?? []),
						{
							type: "custom_message",
							customType: "todos-reminder",
							content: buildReminderMessage(pendingCount, inProgressCount),
							display: true,
						},
					],
					continue: true,
				};
			}
		}
	} catch (e) {
		console.warn(`[todos] completion reminder skipped (fail-open): ${(e as Error).message}`);
	}
}
