import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

import todosExtension from "./index.ts";
import { __resetState, replaceState } from "./core/store.ts";
import type { Task, TaskStatus } from "./types.ts";

type Handler = (event: any, ctx: any) => unknown;

interface CapturedPi {
	handlers: Record<string, Handler>;
	tools: Record<string, any>;
}

function loadExtension(): CapturedPi {
	const handlers: Record<string, Handler> = {};
	const tools: Record<string, any> = {};
	const noop = () => undefined;
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
		registerTool: (def: any) => {
			tools[def.name] = def;
		},
		registerCommand: noop,
		registerShortcut: noop,
		sendMessage: noop,
	};
	todosExtension(pi as never, async () => ({ TodosOverlay: class {} }) as never);
	return { handlers, tools };
}

function setTasks(sessionId: string, statuses: TaskStatus[]): void {
	const tasks: Task[] = statuses.map((status, i) => ({ id: i + 1, subject: `task ${i + 1}`, status }));
	replaceState(sessionId, { tasks, nextId: tasks.length + 1 });
}

function makeCtx(sessionId: string, cwd: string, overrides: Record<string, any> = {}) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({}),
		},
		cwd,
		ui: {
			notify: () => {},
		},
		...overrides,
	};
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

function settleEvent(lastText: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		entries: [],
		continue: false,
		context: { llmMessages: [{ role: "user", content: "mulai" }, assistant(lastText)], contextMessages: [] },
		...overrides,
	};
}

async function withSandbox<T>(
	config: Record<string, any>,
	run: (cwd: string) => Promise<T>,
): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todos-judge-integration-"));
	const prevXdg = process.env.XDG_CONFIG_HOME;
	try {
		fs.mkdirSync(path.join(dir, "config", "todos"), { recursive: true });
		fs.writeFileSync(path.join(dir, "config", "todos", "config.json"), JSON.stringify(config));
		process.env.XDG_CONFIG_HOME = path.join(dir, "config");
		return await run(dir);
	} finally {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("Merged todos & task-judge integration", () => {
	beforeEach(() => {
		__resetState();
	});

	it("enforces code validation before pending todos in enforce mode", async () => {
		await withSandbox({ mode: "enforce" }, async (cwd) => {
			const { handlers } = loadExtension();
			const sid = "session-1";
			const ctx = makeCtx(sid, cwd);

			setTasks(sid, ["in_progress"]);

			// Simulate edit tool result
			handlers.tool_result!(
				{
					toolName: "edit",
					isError: false,
					input: { path: path.join(cwd, "src", "index.ts") },
				},
				ctx,
			);

			// Attempt settle before validation
			const result = (await handlers.agent_before_settle!(
				settleEvent("Pekerjaan selesai"),
				ctx,
			)) as any;

			assert.equal(result.continue, true);
			assert.equal(result.entries.length, 1);
			assert.equal(result.entries[0].customType, "task-judge-enforcement");
			assert.match(result.entries[0].content, /Peringatan task-judge \(Mode Enforce\)/);
		});
	});

	it("allows pending todo reminder after code validation passes", async () => {
		await withSandbox({ mode: "enforce" }, async (cwd) => {
			const { handlers } = loadExtension();
			const sid = "session-2";
			const ctx = makeCtx(sid, cwd);

			setTasks(sid, ["pending"]);

			// Edit file
			handlers.tool_result!(
				{
					toolName: "edit",
					isError: false,
					input: { path: path.join(cwd, "src", "index.ts") },
				},
				ctx,
			);

			// Run successful test
			handlers.tool_result!(
				{
					toolName: "bash",
					isError: false,
					input: { command: "npm test" },
					content: [{ type: "text", text: "all tests passed" }],
				},
				ctx,
			);

			// Attempt settle with pending tasks remaining
			const result = (await handlers.agent_before_settle!(
				settleEvent("Semua tes berhasil dan kode diperbaiki."),
				ctx,
			)) as any;

			assert.equal(result.continue, true);
			assert.equal(result.entries.length, 1);
			assert.equal(result.entries[0].customType, "todos-reminder");
			assert.match(result.entries[0].content, /1 task pending/);
		});
	});

	it("taskGateMode: 'warn' appends advisory warning when completing task with unverified edits", async () => {
		await withSandbox({ taskGateMode: "warn" }, async (cwd) => {
			const { handlers, tools } = loadExtension();
			const sid = "session-3";
			const ctx = makeCtx(sid, cwd);

			const todoTool = tools.todo;
			await todoTool.execute("c1", { action: "create", subject: "Refactor auth" }, undefined, undefined, ctx);

			// Edit code without test
			handlers.tool_result!(
				{
					toolName: "write",
					isError: false,
					input: { path: path.join(cwd, "src", "auth.ts") },
				},
				ctx,
			);

			// Mark task as completed
			const res = await todoTool.execute(
				"u1",
				{ action: "update", id: 1, status: "completed" },
				undefined,
				undefined,
				ctx,
			);

			assert.equal(res.details.tasks[0].status, "completed");
			assert.match(res.content[0].text, /\[task-judge\] Peringatan/);
		});
	});

	it("taskGateMode: 'strict' blocks completing task when unverified edits exist", async () => {
		await withSandbox({ taskGateMode: "strict" }, async (cwd) => {
			const { handlers, tools } = loadExtension();
			const sid = "session-4";
			const ctx = makeCtx(sid, cwd);

			const todoTool = tools.todo;
			await todoTool.execute("c1", { action: "create", subject: "Implement payment" }, undefined, undefined, ctx);

			// Edit code without test
			handlers.tool_result!(
				{
					toolName: "edit",
					isError: false,
					input: { path: path.join(cwd, "src", "payment.ts") },
				},
				ctx,
			);

			// Attempt mark completed in strict mode
			const res = await todoTool.execute(
				"u1",
				{ action: "update", id: 1, status: "completed" },
				undefined,
				undefined,
				ctx,
			);

			assert.match(res.content[0].text, /Task completion blocked by task-judge/);
			assert.equal(res.details.tasks[0].status, "pending");
		});
	});

	it("isolates multi-session edit tracking and judge states", async () => {
		await withSandbox({ mode: "enforce" }, async (cwd) => {
			const { handlers } = loadExtension();
			const sid1 = "session-a";
			const sid2 = "session-b";
			const ctx1 = makeCtx(sid1, cwd);
			const ctx2 = makeCtx(sid2, cwd);

			// Session 1 edits code
			handlers.tool_result!(
				{
					toolName: "edit",
					isError: false,
					input: { path: path.join(cwd, "src", "a.ts") },
				},
				ctx1,
			);

			// Session 2 does NOT edit code
			setTasks(sid2, ["completed"]);

			// Settle Session 2 -> must not be blocked by Session 1's edits
			const result2 = await handlers.agent_before_settle!(
				settleEvent("Session 2 selesai tanpa edit"),
				ctx2,
			);
			assert.equal(result2, undefined);

			// Settle Session 1 -> blocked
			const result1 = (await handlers.agent_before_settle!(
				settleEvent("Session 1 selesai"),
				ctx1,
			)) as any;
			assert.equal(result1.continue, true);
			assert.equal(result1.entries[0].customType, "task-judge-enforcement");
		});
	});
});
