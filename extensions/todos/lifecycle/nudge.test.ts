import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildInactivityNudgeMessage,
	type NudgeState,
	recordToolExecution,
	shouldSendInactivityNudge,
} from "./nudge.ts";

const EMPTY: NudgeState = { mutationCount: 0, hasActiveTodos: true };

const runAll = (state: NudgeState, tools: readonly string[]): NudgeState =>
	tools.reduce((acc, tool) => recordToolExecution(acc, tool), state);

describe("recordToolExecution mutation accumulation", () => {
	it("increments the counter for each of edit, write, bash, and execute", () => {
		for (const tool of ["edit", "write", "bash", "execute"]) {
			assert.equal(recordToolExecution(EMPTY, tool).mutationCount, 1, `tool ${tool} must count as mutation`);
		}
	});

	it("sums consecutive mutations across mixed mutation tools", () => {
		const next = runAll(EMPTY, ["edit", "bash", "write", "execute", "edit"]);
		assert.equal(next.mutationCount, 5);
	});

	it("does not mutate the input state object", () => {
		const before: NudgeState = { mutationCount: 2, hasActiveTodos: true };
		const after = recordToolExecution(before, "edit");
		assert.equal(before.mutationCount, 2);
		assert.equal(after.mutationCount, 3);
		assert.notEqual(after, before);
	});

	it("preserves hasActiveTodos when recording a mutation", () => {
		const after = recordToolExecution({ mutationCount: 0, hasActiveTodos: false }, "edit");
		assert.equal(after.hasActiveTodos, false);
	});
});

describe("recordToolExecution ignores non-mutation tools", () => {
	it("returns the same state object for read, inspect, and web_search", () => {
		for (const tool of ["read", "inspect", "web_search"]) {
			const state: NudgeState = { mutationCount: 4, hasActiveTodos: true };
			assert.equal(recordToolExecution(state, tool), state, `tool ${tool} must not change state`);
		}
	});

	it("does not increment the counter for non-mutation tools across a long sequence", () => {
		const next = runAll(EMPTY, ["read", "inspect", "web_search", "read"]);
		assert.equal(next.mutationCount, 0);
	});
});

describe("recordToolExecution rejects failed calls", () => {
	it("does not count a mutation tool whose call failed", () => {
		const next = recordToolExecution(EMPTY, "bash", true);
		assert.equal(next.mutationCount, 0);
	});

	it("does not reset the counter on a failed todo call", () => {
		const state: NudgeState = { mutationCount: 7, hasActiveTodos: true };
		const next = recordToolExecution(state, "todo", true);
		assert.equal(next.mutationCount, 7);
	});

	it("treats isError === false the same as an omitted flag", () => {
		assert.equal(recordToolExecution(EMPTY, "edit", false).mutationCount, 1);
	});
});

describe("recordToolExecution todo reset", () => {
	it("resets the counter to 0 after a successful todo call", () => {
		const state: NudgeState = { mutationCount: 9, hasActiveTodos: true };
		assert.equal(recordToolExecution(state, "todo").mutationCount, 0);
	});

	it("restarts counting from zero after a todo reset", () => {
		const afterReset = recordToolExecution({ mutationCount: 11, hasActiveTodos: true }, "todo");
		const next = recordToolExecution(afterReset, "edit");
		assert.equal(next.mutationCount, 1);
	});
});

describe("shouldSendInactivityNudge", () => {
	it("returns false without active todos even when mutations reach 12", () => {
		assert.equal(shouldSendInactivityNudge({ mutationCount: 12, hasActiveTodos: false }), false);
		assert.equal(shouldSendInactivityNudge({ mutationCount: 50, hasActiveTodos: false }), false);
	});

	it("returns true exactly when the default threshold of 12 is reached with active todos", () => {
		assert.equal(shouldSendInactivityNudge({ mutationCount: 12, hasActiveTodos: true }), true);
	});

	it("returns false one mutation below the default threshold", () => {
		assert.equal(shouldSendInactivityNudge({ mutationCount: 11, hasActiveTodos: true }), false);
	});

	it("returns true above the threshold while todos are active", () => {
		assert.equal(shouldSendInactivityNudge({ mutationCount: 13, hasActiveTodos: true }), true);
	});

	it("honours a custom threshold instead of the default", () => {
		const state: NudgeState = { mutationCount: 5, hasActiveTodos: true };
		assert.equal(shouldSendInactivityNudge(state, 5), true);
		assert.equal(shouldSendInactivityNudge(state, 6), false);
	});

	it("returns false when todos are inactive even if the custom threshold is 0", () => {
		assert.equal(shouldSendInactivityNudge({ mutationCount: 0, hasActiveTodos: false }, 0), false);
	});

	it("returns false after a todo reset clears the accumulated count", () => {
		const state = runAll(
			{ mutationCount: 0, hasActiveTodos: true },
			[...Array.from({ length: 12 }, () => "edit"), "todo"],
		);
		assert.equal(shouldSendInactivityNudge(state), false);
	});
});

describe("buildInactivityNudgeMessage", () => {
	it("embeds the exact mutation count in the message", () => {
		assert.match(buildInactivityNudgeMessage(12), /\b12 operasi mutasi\b/);
	});

	it("carries the [todo-nudge] marker that downstream consumers match on", () => {
		assert.ok(buildInactivityNudgeMessage(12).startsWith("[todo-nudge] "));
	});

	it("instructs the agent to update active tasks or mark completed tasks", () => {
		const message = buildInactivityNudgeMessage(12);
		assert.match(message, /Perbarui status task aktif/);
		assert.match(message, /tandai task yang telah selesai/);
	});

	it("produces a single line without line breaks", () => {
		assert.equal(buildInactivityNudgeMessage(15).includes("\n"), false);
	});
});
