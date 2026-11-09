import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import todosExtension from "./index.ts";
import { __resetState, replaceState } from "./state/store.ts";
import type { Task, TaskStatus } from "./types.ts";

type Handler = (event: any, ctx: any) => unknown;

/** Registers the extension against a fake `pi` and returns the captured handlers. */
function loadExtension(): Record<string, Handler> {
	const handlers: Record<string, Handler> = {};
	const noop = () => undefined;
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
		registerTool: noop,
		registerCommand: noop,
		registerShortcut: noop,
	};
	// Stub overlay importer: the reminder path never renders the overlay.
	todosExtension(pi as never, async () => ({ TodosOverlay: class {} }) as never);
	return handlers;
}

function setTasks(sessionId: string, statuses: TaskStatus[]): void {
	const tasks: Task[] = statuses.map((status, i) => ({ id: i + 1, subject: `task ${i + 1}`, status }));
	replaceState(sessionId, { tasks, nextId: tasks.length + 1 });
}

const ctxFor = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

function settleEvent(sessionId: string, lastText: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		entries: [],
		continue: false,
		context: { llmMessages: [{ role: "user", content: "kerjakan" }, assistant(lastText)], contextMessages: [] },
		...overrides,
	};
}

const CONCLUSION = "Perubahan selesai dan semua test lulus.";

describe("agent_before_settle completion reminder", () => {
	let handlers: Record<string, Handler>;

	beforeEach(() => {
		__resetState();
		handlers = loadExtension();
	});

	it("queues a todos-reminder continuation when a pending task remains after a conclusion", async () => {
		const sid = "s-pending";
		setTasks(sid, ["completed", "pending"]);

		const result = (await handlers.agent_before_settle!(settleEvent(sid, CONCLUSION), ctxFor(sid))) as any;

		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 1);
		assert.equal(result.entries[0].type, "custom_message");
		assert.equal(result.entries[0].customType, "todos-reminder");
		assert.equal(result.entries[0].display, true);
		assert.match(result.entries[0].content, /\b0 task sedang berjalan\b/);
		assert.match(result.entries[0].content, /\b1 task pending\b/);
	});

	it("keeps entries proposed by earlier handlers instead of dropping them", async () => {
		const sid = "s-chain";
		setTasks(sid, ["in_progress"]);
		const earlier = { type: "custom", customType: "other-ext", data: {} };

		const result = (await handlers.agent_before_settle!(
			settleEvent(sid, CONCLUSION, { entries: [earlier] }),
			ctxFor(sid),
		)) as any;

		assert.equal(result.entries[0], earlier);
		assert.equal(result.entries[1].customType, "todos-reminder");
		assert.match(result.entries[1].content, /\b1 task sedang berjalan\b/);
	});

	it("does not remind when the run was aborted, even with an active task", async () => {
		const sid = "s-aborted";
		setTasks(sid, ["pending"]);

		const result = await handlers.agent_before_settle!(
			settleEvent(sid, CONCLUSION, { outcome: "aborted" }),
			ctxFor(sid),
		);

		assert.equal(result, undefined);
	});

	it("does not remind when every task is completed or deleted", async () => {
		const sid = "s-finished";
		setTasks(sid, ["completed", "deleted"]);

		const result = await handlers.agent_before_settle!(settleEvent(sid, CONCLUSION), ctxFor(sid));

		assert.equal(result, undefined);
	});

	it("does not remind when the assistant is asking the user a question", async () => {
		const sid = "s-question";
		setTasks(sid, ["in_progress"]);

		const result = await handlers.agent_before_settle!(
			settleEvent(sid, "Ada dua opsi migrasi. Mau pakai yang mana?"),
			ctxFor(sid),
		);

		assert.equal(result, undefined);
	});

	it("stops reminding after three reminders in one user-initiated run", async () => {
		const sid = "s-cap";
		setTasks(sid, ["pending"]);
		const settle = () => handlers.agent_before_settle!(settleEvent(sid, CONCLUSION), ctxFor(sid)) as Promise<any>;

		assert.equal((await settle())?.continue, true);
		assert.equal((await settle())?.continue, true);
		assert.equal((await settle())?.continue, true);
		assert.equal(await settle(), undefined, "fourth settle in the same run must not be reminded");
	});

	it("restores the reminder budget when a new user prompt starts a run", async () => {
		const sid = "s-reset";
		setTasks(sid, ["pending"]);
		const settle = () => handlers.agent_before_settle!(settleEvent(sid, CONCLUSION), ctxFor(sid)) as Promise<any>;
		await settle();
		await settle();
		await settle();
		assert.equal(await settle(), undefined);

		handlers.before_agent_start!({ messageType: "user", prompt: "lanjut" }, ctxFor(sid));

		assert.equal((await settle())?.continue, true);
	});

	it("keeps the budget when the run starts from an extension custom message", async () => {
		const sid = "s-custom-start";
		setTasks(sid, ["pending"]);
		const settle = () => handlers.agent_before_settle!(settleEvent(sid, CONCLUSION), ctxFor(sid)) as Promise<any>;
		await settle();
		await settle();
		await settle();

		handlers.before_agent_start!({ messageType: "custom", message: {} }, ctxFor(sid));

		assert.equal(await settle(), undefined, "a continuation started by a custom message must not reset the cap");
	});

	it("tracks reminder budgets per session so one session cannot exhaust another", async () => {
		setTasks("s-a", ["pending"]);
		setTasks("s-b", ["pending"]);
		const settle = (sid: string) => handlers.agent_before_settle!(settleEvent(sid, CONCLUSION), ctxFor(sid)) as Promise<any>;
		await settle("s-a");
		await settle("s-a");
		await settle("s-a");
		assert.equal(await settle("s-a"), undefined);

		assert.equal((await settle("s-b"))?.continue, true);
	});

	it("fails open: a session lookup error resolves to no reminder instead of rejecting", async () => {
		const brokenCtx = {
			sessionManager: {
				getSessionId: () => {
					throw new Error("boom");
				},
			},
		};
		const originalWarn = console.warn;
		console.warn = () => undefined;
		try {
			const result = await handlers.agent_before_settle!(settleEvent("x", CONCLUSION), brokenCtx);
			assert.equal(result, undefined);
		} finally {
			console.warn = originalWarn;
		}
	});
});
