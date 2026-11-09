import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import todosExtension from "./index.ts";
import { __resetState, replaceState } from "./state/store.ts";
import type { Task, TaskStatus } from "./types.ts";

type Handler = (event: any, ctx: any) => unknown;

interface SentMessage {
	message: { customType: string; content: string; display: boolean };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

/** Registers the extension against a fake `pi` and records handlers and sent messages. */
function loadExtension() {
	const handlers: Record<string, Handler> = {};
	const sent: SentMessage[] = [];
	const noop = () => undefined;
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
		registerTool: noop,
		registerCommand: noop,
		registerShortcut: noop,
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			sent.push({ message, options });
		},
	};
	// Stub overlay importer: the nudge path never renders the overlay.
	todosExtension(pi as never, async () => ({ TodosOverlay: class {} }) as never);
	return { handlers, sent };
}

function setTasks(sessionId: string, statuses: TaskStatus[]): void {
	const tasks: Task[] = statuses.map((status, i) => ({ id: i + 1, subject: `task ${i + 1}`, status }));
	replaceState(sessionId, { tasks, nextId: tasks.length + 1 });
}

const ctxFor = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });

const toolResult = (toolName: string, isError = false) => ({ type: "tool_result", toolName, isError });

function runTools(handler: Handler, sessionId: string, toolNames: string[]): void {
	for (const toolName of toolNames) handler(toolResult(toolName), ctxFor(sessionId));
}

const MUTATIONS_TO_NUDGE = 12;
const mutations = (n: number) => Array.from({ length: n }, () => "edit");

describe("tool_result inactivity nudge", () => {
	let handlers: Record<string, Handler>;
	let sent: SentMessage[];

	beforeEach(() => {
		__resetState();
		({ handlers, sent } = loadExtension());
	});

	it("sends one steer nudge at the 12th mutation while a task is in progress", () => {
		const sid = "s-nudge";
		setTasks(sid, ["in_progress"]);

		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE - 1));
		assert.equal(sent.length, 0, "no nudge below the threshold");

		runTools(handlers.tool_result!, sid, ["bash"]);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.message.customType, "todos-nudge");
		assert.equal(sent[0]!.message.display, true);
		assert.equal(sent[0]!.options?.deliverAs, "steer");
		assert.equal(sent[0]!.options?.triggerTurn, undefined, "nudge must not start a turn");
		assert.match(sent[0]!.message.content, /\b12 operasi mutasi\b/);
	});

	it("resets the counter after a nudge so the next mutations do not nudge again immediately", () => {
		const sid = "s-reset";
		setTasks(sid, ["pending"]);

		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE));
		assert.equal(sent.length, 1);

		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE - 1));
		assert.equal(sent.length, 1, "counter restarts from zero after the nudge");

		runTools(handlers.tool_result!, sid, ["write"]);
		assert.equal(sent.length, 2, "second nudge fires after a fresh 12 mutations");
	});

	it("never nudges when no task is pending or in progress", () => {
		const sid = "s-no-active";
		setTasks(sid, ["completed", "deleted"]);

		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE + 5));

		assert.equal(sent.length, 0);
	});

	it("does not count failed mutations toward the threshold", () => {
		const sid = "s-errors";
		setTasks(sid, ["in_progress"]);

		for (let i = 0; i < MUTATIONS_TO_NUDGE + 5; i++) {
			handlers.tool_result!(toolResult("edit", true), ctxFor(sid));
		}

		assert.equal(sent.length, 0);
	});

	it("resets the counter on a successful todo call", () => {
		const sid = "s-todo-reset";
		setTasks(sid, ["in_progress"]);

		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE - 1));
		runTools(handlers.tool_result!, sid, ["todo"]);
		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE - 1));

		assert.equal(sent.length, 0, "todo update clears the mutation streak");
	});

	it("does not count read-only tools", () => {
		const sid = "s-readonly";
		setTasks(sid, ["in_progress"]);

		runTools(handlers.tool_result!, sid, Array.from({ length: MUTATIONS_TO_NUDGE + 5 }, () => "read"));

		assert.equal(sent.length, 0);
	});

	it("keeps mutation counts isolated per session", () => {
		setTasks("s-a", ["in_progress"]);
		setTasks("s-b", ["in_progress"]);

		runTools(handlers.tool_result!, "s-a", mutations(MUTATIONS_TO_NUDGE - 1));
		runTools(handlers.tool_result!, "s-b", mutations(MUTATIONS_TO_NUDGE - 1));
		assert.equal(sent.length, 0, "each session stays below the threshold");

		runTools(handlers.tool_result!, "s-a", ["edit"]);
		assert.equal(sent.length, 1, "only session s-a reaches the threshold");
	});

	it("clears the streak on session_shutdown", async () => {
		const sid = "s-shutdown";
		setTasks(sid, ["in_progress"]);
		runTools(handlers.tool_result!, sid, mutations(MUTATIONS_TO_NUDGE - 1));

		await handlers.session_shutdown!({ type: "session_shutdown" }, ctxFor(sid));

		setTasks(sid, ["in_progress"]);
		runTools(handlers.tool_result!, sid, ["edit"]);
		assert.equal(sent.length, 0, "a streak from before shutdown must not carry over");
	});

	it("fails open when the session lookup throws", () => {
		const originalWarn = console.warn;
		console.warn = () => undefined;
		try {
			const brokenCtx = {
				sessionManager: {
					getSessionId: () => {
						throw new Error("boom");
					},
				},
			};
			assert.doesNotThrow(() => handlers.tool_result!(toolResult("edit"), brokenCtx));
		} finally {
			console.warn = originalWarn;
		}
		assert.equal(sent.length, 0);
	});
});
