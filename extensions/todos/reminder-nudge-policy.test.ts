import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

import todosExtension from "./index.ts";
import {
	__resetState,
	evictSession,
	getJudgeState,
	getNudgeState,
	getTodos,
	replaceState,
	replayFromBranch,
	startDelegation,
	touchTaskInRequest,
} from "./core/store.ts";
import type { Task, TaskStatus } from "./types.ts";

type Handler = (event: any, ctx: any) => unknown;

interface CapturedPi {
	handlers: Record<string, Handler>;
	tools: Record<string, any>;
	sentMessages: any[];
	events: {
		on: (channel: string, handler: (data: any) => void) => void;
		emit: (channel: string, data: any) => void;
	};
}

function loadExtension(): CapturedPi {
	const handlers: Record<string, Handler> = {};
	const tools: Record<string, any> = {};
	const sentMessages: any[] = [];
	const eventBus = new Map<string, Array<(data: any) => void>>();

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
		sendMessage: (msg: any, opts: any) => {
			sentMessages.push({ msg, opts });
		},
		events: {
			on: (channel: string, handler: (data: any) => void) => {
				const list = eventBus.get(channel) ?? [];
				list.push(handler);
				eventBus.set(channel, list);
			},
			emit: (channel: string, data: any) => {
				for (const h of eventBus.get(channel) ?? []) {
					h(data);
				}
			},
		},
	};

	todosExtension(pi as never, async () => ({ TodosOverlay: class {} }) as never);
	return { handlers, tools, sentMessages, events: pi.events };
}

function makeCtx(sessionId: string, cwd = process.cwd(), overrides: Record<string, any> = {}) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({}),
			getBranch: () => [],
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

async function withSandbox<T>(config: Record<string, any>, run: (cwd: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todos-policy-test-"));
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

describe("Todos Reminder & Nudge Policy Runtime Tests", () => {
	beforeEach(() => {
		__resetState();
	});

	// 1. Task identik dua kali settle
	it("deduplicates reminder on identical task condition across two settles", async () => {
		const { handlers } = loadExtension();
		const sid = "sess-dedup";
		const ctx = makeCtx(sid);

		replaceState(sid, {
			tasks: [{ id: 1, subject: "Refactor router", status: "pending" }],
			nextId: 2,
		});

		// First settle queues continuation
		const first = (await handlers.agent_before_settle!(
			settleEvent("Pekerjaan selesai"),
			ctx,
		)) as any;
		assert.equal(first?.continue, true);
		assert.equal(first?.entries?.[0]?.customType, "todos-reminder");

		// Second settle with identical pending task must not force continuation
		const second = (await handlers.agent_before_settle!(
			settleEvent("Pekerjaan selesai"),
			ctx,
		)) as any;
		assert.equal(second, undefined, "identical task condition must not force duplicate continuation");
	});

	// 2. Shared continuation budget (judge enforcement + todos reminder)
	it("shares the continuation budget between task-judge enforcement and completion reminder", async () => {
		await withSandbox({ mode: "enforce", reminder: { maxInterventions: 2 } }, async (cwd) => {
			const { handlers } = loadExtension();
			const sid = "sess-shared-budget";
			const ctx = makeCtx(sid, cwd);

			replaceState(sid, {
				tasks: [{ id: 1, subject: "Pending task", status: "pending" }],
				nextId: 2,
			});

			// Unverified edit
			handlers.tool_result!(
				{ toolName: "edit", isError: false, input: { path: path.join(cwd, "src", "app.ts") } },
				ctx,
			);

			// First settle: judge enforcement consumes 1st intervention
			const res1 = (await handlers.agent_before_settle!(settleEvent("Selesai 1"), ctx)) as any;
			assert.equal(res1?.continue, true);
			assert.equal(res1?.entries?.[0]?.customType, "task-judge-enforcement");

			// Second settle: unverified edits persist, judge enforcement consumes 2nd intervention
			const res2 = (await handlers.agent_before_settle!(settleEvent("Selesai 2"), ctx)) as any;
			assert.equal(res2?.continue, true);
			assert.equal(res2?.entries?.[0]?.customType, "task-judge-enforcement");

			// Third settle: shared budget (2) exhausted; neither judge nor reminder forces continuation
			const res3 = (await handlers.agent_before_settle!(settleEvent("Selesai 3"), ctx)) as any;
			assert.equal(res3, undefined, "shared intervention budget must prevent runaway continuations");
		});
	});

	// 3. Task lokal bersama workflow aktif
	it("reminds actionable local tasks while another task is waiting on an active workflow", async () => {
		const { handlers } = loadExtension();
		const sid = "sess-local-with-workflow";
		const ctx = makeCtx(sid);

		startDelegation(sid, "wf_auth_audit");

		replaceState(sid, {
			tasks: [
				{
					id: 1,
					subject: "Audit auth routes",
					status: "in_progress",
					metadata: { workflowId: "wf_auth_audit" },
				},
				{
					id: 2,
					subject: "Update local README documentation",
					status: "pending",
				},
			],
			nextId: 3,
		});

		const result = (await handlers.agent_before_settle!(
			settleEvent("Audit sedang berjalan di background"),
			ctx,
		)) as any;

		assert.equal(result?.continue, true);
		assert.equal(result?.entries?.[0]?.customType, "todos-reminder");
		// Reminder counts only actionable local tasks (1 pending), excluding the task waiting on workflow
		assert.match(result?.entries?.[0]?.content, /1 task pending/);
		assert.match(result?.entries?.[0]?.content, /0 task sedang berjalan/);
	});

	// 4. Waiting worker/user/dependency exclusion
	it("excludes tasks waiting on workers, user input, or dependencies from forcing completion", async () => {
		const { handlers } = loadExtension();
		const sid = "sess-waiting-all";
		const ctx = makeCtx(sid);

		startDelegation(sid, "worker_agent_1");

		replaceState(sid, {
			tasks: [
				// Task 1: waiting on active worker
				{ id: 1, subject: "Worker task", status: "in_progress", metadata: { workerId: "worker_agent_1" } },
				// Task 2: waiting on unfinished dependency (blocked by 1)
				{ id: 2, subject: "Dependent task", status: "pending", blockedBy: [1] },
				// Task 3: waiting on user input
				{ id: 3, subject: "Design decision", status: "pending", metadata: { waitingFor: "user" } },
			],
			nextId: 4,
		});

		const result = await handlers.agent_before_settle!(
			settleEvent("Semua tugas yang belum selesai sedang menunggu worker/user/dependensi"),
			ctx,
		);

		assert.equal(result, undefined, "all tasks are waiting on worker/dependency/user, so reminder must be suppressed");
	});

	// 5. Request baru dengan task lama
	it("does not interrupt a new user request with unadopted old tasks from previous turns", async () => {
		const { handlers, tools } = loadExtension();
		const sid = "sess-old-tasks";
		const ctx = makeCtx(sid);

		// Turn 1: user requests task creation
		handlers.before_agent_start!({ messageType: "user", prompt: "Buat rencana kerja" }, ctx);
		await tools.todo.execute("c1", { action: "create", subject: "Task dari turn 1" }, undefined, undefined, ctx);

		// Turn 2: unrelated new user request arrives without touching or mentioning the old task
		handlers.before_agent_start!({ messageType: "user", prompt: "Siapa penemu bahasa Python?" }, ctx);

		// Settle turn 2: old task must NOT trigger reminder
		const resultTurn2 = await handlers.agent_before_settle!(
			settleEvent("Penemu Python adalah Guido van Rossum."),
			ctx,
		);
		assert.equal(resultTurn2, undefined, "unadopted old task must not interrupt new user request");

		// Turn 3: user explicitly adopts task #1
		handlers.before_agent_start!({ messageType: "user", prompt: "Lanjutkan task #1 sekarang" }, ctx);
		const resultTurn3 = (await handlers.agent_before_settle!(
			settleEvent("Saya sudah mulai memeriksa kodenya."),
			ctx,
		)) as any;
		assert.equal(resultTurn3?.continue, true, "explicitly adopted task must be eligible for reminder");
	});

	// 6. Event workflow terminal & review hasil
	it("marks delegated tasks ready for review on terminal event without prematurely completing them", async () => {
		const { handlers, events } = loadExtension();
		const sid = "sess-workflow-terminal";
		const ctx = makeCtx(sid);

		replaceState(sid, {
			tasks: [
				{
					id: 1,
					subject: "Refactor subagent pool",
					status: "in_progress",
					owner: "worker-pool-1",
				},
			],
			nextId: 2,
		});

		// Subagent completes via pi.events
		events.emit("subagents:completed", {
			id: "worker-pool-1",
			result: "All 15 subagent files updated successfully",
		});

		const tasksAfter = getTodos(sid);
		const task1 = tasksAfter.find((t) => t.id === 1)!;

		// Task status MUST stay in_progress (NOT auto-completed)
		assert.equal(task1.status, "in_progress");
		// Task metadata MUST mark reviewReady and store result
		assert.equal(task1.metadata?.reviewReady, true);
		assert.equal(task1.metadata?.delegationStatus, "completed");
		assert.equal(task1.metadata?.delegationResult, "All 15 subagent files updated successfully");

		// Now that it is reviewReady, it is actionable for parent review and can be reminded
		const result = (await handlers.agent_before_settle!(
			settleEvent("Delegasi selesai."),
			ctx,
		)) as any;
		assert.equal(result?.continue, true);
		assert.match(result?.entries?.[0]?.content, /1 task sedang berjalan/);
	});

	// 7. Sesi berbeda (session isolation)
	it("strictly isolates budgets, fingerprints, and state across different sessions", async () => {
		const { handlers } = loadExtension();
		const sidA = "sess-iso-A";
		const sidB = "sess-iso-B";
		const ctxA = makeCtx(sidA);
		const ctxB = makeCtx(sidB);

		replaceState(sidA, { tasks: [{ id: 1, subject: "Task A", status: "pending" }], nextId: 2 });
		replaceState(sidB, { tasks: [{ id: 1, subject: "Task B", status: "pending" }], nextId: 2 });

		// Settle Session A
		const resA1 = (await handlers.agent_before_settle!(settleEvent("A done"), ctxA)) as any;
		assert.equal(resA1?.continue, true);

		// Settle Session A again -> deduplicated
		const resA2 = (await handlers.agent_before_settle!(settleEvent("A done"), ctxA)) as any;
		assert.equal(resA2, undefined);

		// Settle Session B -> budget and deduplication in A must not affect B
		const resB1 = (await handlers.agent_before_settle!(settleEvent("B done"), ctxB)) as any;
		assert.equal(resB1?.continue, true, "Session B must have its own fresh budget and fingerprint");
	});

	// 8. Read-only shell vs mutasi nyata
	it("does not count read-only and validation shell commands as mutations for inactivity nudge", async () => {
		const { handlers, sentMessages } = loadExtension();
		const sid = "sess-nudge-readonly";
		const ctx = makeCtx(sid);

		replaceState(sid, { tasks: [{ id: 1, subject: "Active work", status: "in_progress" }], nextId: 2 });

		const readOnlyCommands = [
			"git status",
			"git diff",
			"git log -n 5",
			"ls -la",
			"pwd",
			"cat src/index.ts",
			"find . -name '*.ts'",
			"npm test", // validation command
			"grep -rn 'foo' src/",
		];

		// Execute read-only and validation commands 20 times
		for (let i = 0; i < 20; i++) {
			const cmd = readOnlyCommands[i % readOnlyCommands.length];
			handlers.tool_result!(
				{ toolName: "bash", isError: false, input: { command: cmd } },
				ctx,
			);
		}

		assert.equal(getNudgeState(sid).mutationCount, 0, "read-only and validation commands must not increment mutation count");
		assert.equal(sentMessages.length, 0, "no nudge must be sent for read-only commands");

		// Now execute genuine mutation commands
		for (let i = 0; i < 12; i++) {
			handlers.tool_result!(
				{ toolName: "bash", isError: false, input: { command: `npm install dep-${i}` } },
				ctx,
			);
		}

		assert.equal(sentMessages.length, 1, "genuine mutating commands must trigger nudge at threshold");
		assert.equal(sentMessages[0].msg.customType, "todos-nudge");
	});

	// 9. list/get dan no-op update tidak mereset inactivity tracking
	it("resets inactivity tracking only on real progress, not on list/get or no-op updates", async () => {
		const { handlers, tools } = loadExtension();
		const sid = "sess-nudge-reset";
		const ctx = makeCtx(sid);

		replaceState(sid, {
			tasks: [{ id: 1, subject: "Refactor parser", status: "pending" }],
			nextId: 2,
		});

		// 5 code mutations
		for (let i = 0; i < 5; i++) {
			handlers.tool_result!({ toolName: "edit", isError: false, input: { path: "src/a.ts" } }, ctx);
		}
		assert.equal(getNudgeState(sid).mutationCount, 5);

		// todo list -> does not reset
		await tools.todo.execute("l1", { action: "list" }, undefined, undefined, ctx);
		handlers.tool_result!({ toolName: "todo", isError: false, input: { action: "list" }, content: [{ type: "text", text: "[pending] #1 Refactor parser" }] }, ctx);
		assert.equal(getNudgeState(sid).mutationCount, 5, "todo list must not reset mutation count");

		// todo get -> does not reset
		await tools.todo.execute("g1", { action: "get", id: 1 }, undefined, undefined, ctx);
		handlers.tool_result!({ toolName: "todo", isError: false, input: { action: "get", id: 1 }, content: [{ type: "text", text: "#1 [pending] Refactor parser" }] }, ctx);
		assert.equal(getNudgeState(sid).mutationCount, 5, "todo get must not reset mutation count");

		// no-op update -> does not reset
		await tools.todo.execute("u1", { action: "update", id: 1, status: "pending" }, undefined, undefined, ctx);
		handlers.tool_result!({ toolName: "todo", isError: false, input: { action: "update", id: 1, status: "pending" }, content: [{ type: "text", text: "No change: #1 already matches the requested values (status: pending)" }] }, ctx);
		assert.equal(getNudgeState(sid).mutationCount, 5, "no-op update must not reset mutation count");

		// real update with status transition -> resets!
		await tools.todo.execute("u2", { action: "update", id: 1, status: "in_progress" }, undefined, undefined, ctx);
		handlers.tool_result!({ toolName: "todo", isError: false, input: { action: "update", id: 1, status: "in_progress" }, content: [{ type: "text", text: "Updated #1 (pending → in_progress)" }] }, ctx);
		assert.equal(getNudgeState(sid).mutationCount, 0, "real progress must reset mutation count to 0");
	});

	// 10. Deduplikasi fingerprint pada inactivity nudge
	it("deduplicates inactivity nudge on identical task condition and allows next nudge after fingerprint changes within budget", async () => {
		const { handlers, tools, sentMessages } = loadExtension();
		const sid = "sess-nudge-dedup";
		const ctx = makeCtx(sid);

		replaceState(sid, {
			tasks: [{ id: 1, subject: "Refactor backend", status: "pending" }],
			nextId: 2,
		});

		// 1. Initial 12 mutations trigger the first nudge
		for (let i = 0; i < 12; i++) {
			handlers.tool_result!({ toolName: "edit", isError: false, input: { path: `src/mod${i}.ts` } }, ctx);
		}
		assert.equal(sentMessages.length, 1, "first nudge must fire after reaching 12 mutations");
		assert.equal(sentMessages[0].msg.customType, "todos-nudge");

		// 2. 12 more mutations with identical task condition must NOT send another nudge
		for (let i = 0; i < 12; i++) {
			handlers.tool_result!({ toolName: "edit", isError: false, input: { path: `src/mod${i}.ts` } }, ctx);
		}
		assert.equal(sentMessages.length, 1, "second nudge must NOT fire when task condition is identical");

		// 3. Update task status: changes fingerprint and resets mutationCount
		await tools.todo.execute("u1", { action: "update", id: 1, status: "in_progress" }, undefined, undefined, ctx);
		handlers.tool_result!({
			toolName: "todo",
			isError: false,
			input: { action: "update", id: 1, status: "in_progress" },
			content: [{ type: "text", text: "Updated #1 (pending → in_progress)" }],
		}, ctx);

		// 4. 12 more mutations after fingerprint change trigger second nudge within maxPerRequest budget
		for (let i = 0; i < 12; i++) {
			handlers.tool_result!({ toolName: "edit", isError: false, input: { path: `src/mod${i}.ts` } }, ctx);
		}
		assert.equal(sentMessages.length, 2, "second nudge must fire after fingerprint changes and fresh mutations");
		assert.equal(sentMessages[1].msg.customType, "todos-nudge");

		// 5. Subsequent mutations with identical fingerprint do NOT fire third nudge
		for (let i = 0; i < 12; i++) {
			handlers.tool_result!({ toolName: "edit", isError: false, input: { path: `src/mod${i}.ts` } }, ctx);
		}
		assert.equal(sentMessages.length, 2, "identical fingerprint must not fire third nudge");

		// 6. Even if fingerprint changes again, maxPerRequest budget of 2 is exhausted
		await tools.todo.execute("c2", { action: "create", subject: "Second feature" }, undefined, undefined, ctx);
		handlers.tool_result!({
			toolName: "todo",
			isError: false,
			input: { action: "create", subject: "Second feature" },
			content: [{ type: "text", text: "Created #2" }],
		}, ctx);
		for (let i = 0; i < 12; i++) {
			handlers.tool_result!({ toolName: "edit", isError: false, input: { path: `src/mod${i}.ts` } }, ctx);
		}
		assert.equal(sentMessages.length, 2, "third nudge must NOT fire because maxPerRequest budget is exhausted");
	});

	// 10. Investigation task not blocked by unrelated edits
	it("allows completing investigation tasks even when unverified code edits exist", async () => {
		await withSandbox({ taskGateMode: "strict" }, async (cwd) => {
			const { handlers, tools } = loadExtension();
			const sid = "sess-investigation";
			const ctx = makeCtx(sid, cwd);

			// Edit code without validation
			handlers.tool_result!(
				{ toolName: "edit", isError: false, input: { path: path.join(cwd, "src", "backend.ts") } },
				ctx,
			);

			// Create an investigation task
			await tools.todo.execute(
				"c1",
				{ action: "create", subject: "Investigate database latency spike" },
				undefined,
				undefined,
				ctx,
			);

			// Mark investigation task completed -> MUST NOT be blocked
			const res = await tools.todo.execute(
				"u1",
				{ action: "update", id: 1, status: "completed" },
				undefined,
				undefined,
				ctx,
			);

			assert.equal(res.details.tasks[0].status, "completed", "investigation task completion must not be blocked by unrelated code edits");
			assert.ok(!res.content[0].text.includes("Task completion blocked"));

			// In contrast, completing a code implementation task MUST be blocked
			await tools.todo.execute(
				"c2",
				{ action: "create", subject: "Implement payment retry" },
				undefined,
				undefined,
				ctx,
			);
			const codeTaskRes = await tools.todo.execute(
				"u2",
				{ action: "update", id: 2, status: "completed" },
				undefined,
				undefined,
				ctx,
			);
			assert.equal(codeTaskRes.details.tasks[1].status, "pending");
			assert.match(codeTaskRes.content[0].text, /Task completion blocked by task-judge/);
		});
	});

	// 11. Continuation does not wipe unverified edits on agent_start
	it("preserves unverified edit records across continuation turns", async () => {
		await withSandbox({ mode: "enforce" }, async (cwd) => {
			const { handlers } = loadExtension();
			const sid = "sess-continuation-judge";
			const ctx = makeCtx(sid, cwd);

			// Record unverified edit
			handlers.tool_result!(
				{ toolName: "edit", isError: false, input: { path: path.join(cwd, "src", "calc.ts") } },
				ctx,
			);
			assert.equal(getJudgeState(sid).edits.length, 1);

			// First settle rejected
			const settle1 = (await handlers.agent_before_settle!(settleEvent("Selesai"), ctx)) as any;
			assert.equal(settle1?.continue, true);

			// Pi starts continuation turn (fires agent_start)
			await handlers.agent_start!({}, ctx);

			// Unverified edits MUST still be present in judgeState!
			assert.equal(getJudgeState(sid).edits.length, 1, "unverified edits must survive continuation turn");
		});
	});

	// 12. Session eviction & replay lifecycle
	it("evicts session state cleanly on shutdown and reconstructs accurately from branch", async () => {
		const sid = "sess-lifecycle";
		const ctx = makeCtx(sid);
		const { handlers, tools } = loadExtension();

		await tools.todo.execute("c1", { action: "create", subject: "Persistent task" }, undefined, undefined, ctx);
		assert.equal(getTodos(sid).length, 1);

		// Shutdown evicts slot
		await handlers.session_shutdown!({}, ctx);
		// After eviction, requesting todos gives clean empty state
		assert.equal(getTodos(sid).length, 0);

		// Replay from simulated branch restores state
		const fakeBranch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						action: "create",
						params: {},
						tasks: [{ id: 1, subject: "Persistent task", status: "pending" }],
						nextId: 2,
					},
				},
			},
		];
		const restored = replayFromBranch({ sessionManager: { getBranch: () => fakeBranch } });
		assert.equal(restored.tasks.length, 1);
		assert.equal(restored.tasks[0].subject, "Persistent task");
	});
});
