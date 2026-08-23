import assert from "node:assert/strict";
import test from "node:test";

import { applyTaskMutation } from "./state/reducer.ts";
import { detectCycle } from "./state/reducer.ts";
import {
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "./state/selectors.ts";
import { EMPTY_STATE, __resetState, replayFromBranch } from "./state/store.ts";

test.afterEach(() => __resetState());

const fresh = () => ({ tasks: [], nextId: 1 });

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: adds task with next id, pending status", () => {
	const r1 = applyTaskMutation(fresh(), "create", { subject: "Research existing tool" });
	assert.equal(r1.op.kind, "create");
	assert.deepEqual(r1.state.tasks, [{ id: 1, subject: "Research existing tool", status: "pending" }]);
	assert.equal(r1.state.nextId, 2);

	const r2 = applyTaskMutation(r1.state, "create", { subject: "Write tests", description: "unit + e2e" });
	assert.equal(r2.state.tasks[1].id, 2);
	assert.equal(r2.state.tasks[1].description, "unit + e2e");
});

test("create: subject required", () => {
	const r = applyTaskMutation(fresh(), "create", { subject: "   " });
	assert.equal(r.op.kind, "error");
	assert.equal(r.state.tasks.length, 0);
});

test("create: blockedBy validates existence and non-deleted", () => {
	const withTask = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	const missing = applyTaskMutation(withTask, "create", { subject: "B", blockedBy: [99] });
	assert.equal(missing.op.kind, "error");
	assert.match(missing.op.message, /#99 not found/);

	const deleted = applyTaskMutation(withTask, "delete", { id: 1 }).state;
	const onDeleted = applyTaskMutation(deleted, "create", { subject: "B", blockedBy: [1] });
	assert.equal(onDeleted.op.kind, "error");
	assert.match(onDeleted.op.message, /is deleted/);
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

test("update: status transition + changed flag", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "create", { subject: "B" }).state;

	const r = applyTaskMutation(state, "update", { id: 1, status: "in_progress", activeForm: "writing tests" });
	assert.equal(r.op.kind, "update");
	if (r.op.kind === "update") assert.equal(r.op.changed, true);
	assert.equal(r.state.tasks[0].status, "in_progress");
	assert.equal(r.state.tasks[0].activeForm, "writing tests");

	const noop = applyTaskMutation(r.state, "update", { id: 1, status: "in_progress" });
	assert.equal(noop.op.kind, "update");
	if (noop.op.kind === "update") assert.equal(noop.op.changed, false);
});

test("update: illegal transition rejected", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "update", { id: 1, status: "completed" }).state;
	const r = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
	assert.equal(r.op.kind, "error");
	assert.match(r.op.message, /illegal transition/);
});

test("update: deleted tombstones are immutable", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "delete", { id: 1 }).state;
	const r = applyTaskMutation(state, "update", { id: 1, subject: "changed" });
	assert.equal(r.op.kind, "error");
	assert.match(r.op.message, /is deleted/);
	assert.equal(r.state.tasks[0].subject, "A");
});

test("update: id required / not found / no mutable field", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	assert.equal(applyTaskMutation(state, "update", { status: "completed" }).op.kind, "error");
	assert.equal(applyTaskMutation(state, "update", { id: 99, status: "completed" }).op.kind, "error");
	assert.equal(applyTaskMutation(state, "update", { id: 1 }).op.kind, "error");
});

test("update: metadata merge + null delete", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A", metadata: { k1: "v1", k2: "v2" } }).state;
	state = applyTaskMutation(state, "update", { id: 1, metadata: { k2: null, k3: "v3" } }).state;
	assert.deepEqual(state.tasks[0].metadata, { k1: "v1", k3: "v3" });
});

test("update: addBlockedBy self-block, missing dep, cycle", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "create", { subject: "B" }).state;

	const self = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
	assert.equal(self.op.kind, "error");
	assert.match(self.op.message, /cannot block/);

	const missing = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [42] });
	assert.equal(missing.op.kind, "error");

	state = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] }).state;
	const cycle = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
	assert.equal(cycle.op.kind, "error");
	assert.match(cycle.op.message, /cycle/);
});

test("detectCycle: direct and transitive", () => {
	const tasks = [
		{ id: 1, subject: "a", status: "pending" as const },
		{ id: 2, subject: "b", status: "pending" as const, blockedBy: [1] },
		{ id: 3, subject: "c", status: "pending" as const, blockedBy: [2] },
	];
	assert.equal(detectCycle(tasks, 2, [1]), false);
	assert.equal(detectCycle(tasks, 1, [3]), true); // 1 → 3 → 2 → 1
	assert.equal(detectCycle(tasks, 3, [1]), false); // 3 → 2 → 1, acyclic
});

// ---------------------------------------------------------------------------
// delete / clear / list / get
// ---------------------------------------------------------------------------

test("delete: tombstones; already-deleted rejected", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	const r = applyTaskMutation(state, "delete", { id: 1 });
	assert.equal(r.op.kind, "delete");
	assert.equal(r.state.tasks[0].status, "deleted");
	assert.equal(applyTaskMutation(r.state, "delete", { id: 1 }).op.kind, "error");
});

test("clear: empties and resets nextId", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "create", { subject: "B" }).state;
	const r = applyTaskMutation(state, "clear", {});
	assert.equal(r.op.kind, "clear");
	assert.equal(r.op.count, 2);
	assert.deepEqual(r.state, EMPTY_STATE);
});

test("list: filters status and deleted", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "create", { subject: "B" }).state;
	state = applyTaskMutation(state, "update", { id: 1, status: "completed" }).state;
	state = applyTaskMutation(state, "delete", { id: 2 }).state;

	assert.equal(applyTaskMutation(state, "list", {}).op.kind, "list");
	const visible = selectVisibleTasks(state);
	assert.deepEqual(visible.map((t) => t.id), [1]);
});

test("get: found and missing", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	const ok = applyTaskMutation(state, "get", { id: 1 });
	assert.equal(ok.op.kind, "get");
	assert.equal(ok.op.task.subject, "A");
	assert.equal(applyTaskMutation(state, "get", { id: 9 }).op.kind, "error");
});

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

test("selectors: counts, groups, active, showIds, layout", () => {
	let state = applyTaskMutation(fresh(), "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "create", { subject: "B", blockedBy: [1] }).state;
	state = applyTaskMutation(state, "update", { id: 1, status: "in_progress" }).state;
	state = applyTaskMutation(state, "create", { subject: "C" }).state;
	state = applyTaskMutation(state, "update", { id: 3, status: "completed" }).state;

	assert.deepEqual(selectTodoCounts(state), { total: 3, pending: 1, inProgress: 1, completed: 1 });
	assert.deepEqual(selectTasksByStatus(state).inProgress.map((t) => t.id), [1]);
	assert.equal(selectHasActive(state), true);
	assert.equal(selectShowTaskIds(state), true);

	const layout = selectOverlayLayout(state, 2);
	// budget 2: heading + 1 body row; completed dropped, tail truncated
	assert.equal(layout.visible.length, 1);
	assert.equal(layout.hiddenCompleted, 1);
	assert.equal(layout.truncatedTail, 1);
});

// ---------------------------------------------------------------------------
// branch replay
// ---------------------------------------------------------------------------

function mockCtx(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } };
}

test("replayFromBranch: last todo result wins", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { action: "create", params: {}, tasks: [{ id: 1, subject: "A", status: "pending" }], nextId: 2 },
			},
		},
		{ type: "message", message: { role: "toolResult", toolName: "ls", details: { whatever: true } } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "update",
					params: {},
					tasks: [
						{ id: 1, subject: "A", status: "completed" },
						{ id: 2, subject: "B", status: "pending" },
					],
					nextId: 3,
				},
			},
		},
	];
	const state = replayFromBranch(mockCtx(branch));
	assert.equal(state.nextId, 3);
	assert.deepEqual(state.tasks.map((t) => t.subject), ["A", "B"]);
	assert.equal(state.tasks[0].status, "completed");
});

test("replayFromBranch: empty/bad branch → EMPTY_STATE", () => {
	assert.deepEqual(replayFromBranch(mockCtx([])), EMPTY_STATE);
	assert.deepEqual(
		replayFromBranch(mockCtx([{ type: "message", message: { role: "toolResult", toolName: "todo", details: "junk" } }])),
		EMPTY_STATE,
	);
	assert.deepEqual(
		replayFromBranch(
			mockCtx([
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: { tasks: [{ id: 1, subject: "bad", status: "unknown" }], nextId: 2 },
					},
				},
			]),
		),
		EMPTY_STATE,
	);
});
