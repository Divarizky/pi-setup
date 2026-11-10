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
	shouldRemindPendingTodos,
} from "./reminder.ts";
import {
	getEnforceRetries,
	getJudgeState,
	getReminderCount,
	getTodos,
	incrementEnforceRetries,
	setReminderCount,
	sid,
} from "../core/store.ts";

export const ENFORCE_MAX_RETRIES = 2;
export const REMINDER_MAX_RETRIES = 3;

export function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant") continue;
		return extractText(m.content);
	}
	return "";
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
				if (used >= ENFORCE_MAX_RETRIES) {
					ctx.ui?.notify?.(
						"Batas retry enforce task-judge tercapai; sesi diselesaikan tanpa validasi sukses.",
						"warning",
					);
				} else {
					incrementEnforceRetries(id);
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
		const tasks = getTodos(id);
		if (tasks.some((t) => t.status === "pending" || t.status === "in_progress")) {
			const reminderCount = getReminderCount(id);
			const lastText = lastAssistantText(event.context.llmMessages);
			if (
				shouldRemindPendingTodos({
					tasks,
					lastAssistantText: lastText,
					reminderCount,
					maxRetries: REMINDER_MAX_RETRIES,
				})
			) {
				setReminderCount(id, reminderCount + 1);
				const pendingCount = tasks.filter((t) => t.status === "pending").length;
				const inProgressCount = tasks.filter((t) => t.status === "in_progress").length;
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
