/**
 * `todo` tool registration + response envelope.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyTaskMutation, deriveBlocks } from "./core/reducer.ts";
import type { Op } from "./core/reducer.ts";
import type { TaskState } from "./core/store.ts";
import { commitState, getJudgeState, getRenderState, getState, sid } from "./core/store.ts";
import {
	getEffectiveDocExtensions,
	getEffectiveValidationPatterns,
	getTaskGateMode,
} from "./config.ts";
import { evaluateRun } from "./judge/judge.ts";
import {
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
	type Task,
	type TaskAction,
	type TaskDetails,
	type TaskMutationParams,
} from "./types.ts";
import { renderTodoCall, renderTodoResult } from "./overlay/format.ts";

// ---------------------------------------------------------------------------
// Prompt guidance (hardcoded; English — LLM-facing copy stays English)
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
	"Subject: imperative verb first, under 8 words, no articles or trailing punctuation (e.g. 'Fix auth middleware' — not 'Fix the auth middleware issue we discussed').",
	"Bad: 'Make sure that the user authentication flow gets fixed properly' → Good: 'Fix auth flow'",
];

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
}

function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}

/** Pure formatter: `(op, state) → string`. Closed switch on `op.kind`. */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			if (!t) return `Created #${op.taskId}`;
			return `Created #${t.id}: ${t.subject} (pending)`;
		}
		case "update": {
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${op.subject}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/** Build the LLM-facing tool envelope after the store commits new state.
 * `details` is the persistence + replay snapshot consumed by replayFromBranch. */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action as TaskAction;
			const p = params as TaskMutationParams;

			// Task-aware verification gate: when marking a task as completed
			let warningSuffix = "";
			if (action === "update" && p.status === "completed") {
				const gateMode = getTaskGateMode();
				if (gateMode !== "off") {
					const judgeState = getJudgeState(sid(ctx));
					const docExtensions = getEffectiveDocExtensions();
					const validationPatterns = getEffectiveValidationPatterns(ctx.cwd);
					const evaluation = evaluateRun(judgeState, { docExtensions, validationPatterns });

					if (evaluation.decision === "tidak_terverifikasi") {
						if (gateMode === "strict") {
							const errorOp: Op = {
								kind: "error",
								message:
									"Task completion blocked by task-judge: file diedit tanpa perintah validasi yang sukses setelah edit terakhir. Jalankan test/linter sebelum menandai task sebagai completed.",
							};
							ctx.ui?.notify?.(
								"Task completion blocked: file diedit tanpa validasi sukses.",
								"error",
							);
							return buildToolResult(action, p, getState(sid(ctx)), errorOp);
						}
						// gateMode === "warn"
						warningSuffix =
							"\n\n[task-judge] Peringatan: Terdapat modifikasi berkas tanpa perintah validasi yang sukses setelah edit terakhir.";
						ctx.ui?.notify?.(
							"Peringatan task-judge: task ditandai completed saat ada edit kode yang belum divalidasi.",
							"warning",
						);
					}
				}
			}

			const result = applyTaskMutation(getState(sid(ctx)), action, p);
			commitState(sid(ctx), result.state);
			const toolResult = buildToolResult(action, p, result.state, result.op);
			if (warningSuffix && toolResult.content[0]) {
				toolResult.content[0].text += warningSuffix;
			}
			return toolResult;
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's — the
		// ctx-less ToolRenderContext cannot re-key by caller. For the foreground
		// session's own transcript that is exactly right.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as TaskMutationParams & { action: TaskAction }, theme, getRenderState());
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}
