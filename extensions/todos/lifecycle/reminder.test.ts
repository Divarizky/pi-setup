import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Task, TaskStatus } from "../types.ts";
import { buildReminderMessage, isWaitingForUserInput, shouldRemindPendingTodos } from "./reminder.ts";

const task = (id: number, status: TaskStatus): Task => ({ id, subject: `task ${id}`, status });

const CONCLUSION = "Perubahan selesai dan semua test lulus.";

describe("shouldRemindPendingTodos", () => {
	it("returns false when there are no tasks, so no reminder is queued for an empty list", () => {
		assert.equal(shouldRemindPendingTodos({ tasks: [], lastAssistantText: CONCLUSION, reminderCount: 0 }), false);
	});

	it("returns false when every task is completed or deleted, so finished work is not nagged", () => {
		const tasks = [task(1, "completed"), task(2, "deleted"), task(3, "completed")];
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 0 }), false);
	});

	it("returns true for a pending task when the assistant only states a conclusion", () => {
		const tasks = [task(1, "completed"), task(2, "pending")];
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 0 }), true);
	});

	it("returns true for a plain statement ending with a period while the task is still pending", () => {
		const tasks = [task(1, "pending")];
		const text = "Saya sudah menyelesaikan bagian parser.";
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: text, reminderCount: 0 }), true);
	});

	it("returns true for an in_progress task when the assistant only states a conclusion", () => {
		const tasks = [task(1, "in_progress")];
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 0 }), true);
	});

	it("returns false once reminderCount reaches the default limit of 3", () => {
		const tasks = [task(1, "pending")];
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 2 }), true);
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 3 }), false);
		assert.equal(shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 4 }), false);
	});

	it("honours a custom maxRetries instead of the default", () => {
		const tasks = [task(1, "pending")];
		assert.equal(
			shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 1, maxRetries: 1 }),
			false,
		);
		assert.equal(
			shouldRemindPendingTodos({ tasks, lastAssistantText: CONCLUSION, reminderCount: 4, maxRetries: 5 }),
			true,
		);
	});

	it("returns false when the assistant asks the user a question while a task is active", () => {
		const tasks = [task(1, "in_progress")];
		assert.equal(
			shouldRemindPendingTodos({
				tasks,
				lastAssistantText: "Ada dua opsi migrasi. Mau pakai yang mana?",
				reminderCount: 0,
			}),
			false,
		);
	});
});

describe("isWaitingForUserInput", () => {
	const idQuestions = [
		"Apakah boleh saya menghapus file lama itu?",
		"Bagaimana menurut Anda, pakai pendekatan A atau B?",
		"Apakah Anda setuju dengan perubahan ini?",
		"Mohon konfirmasi sebelum saya melanjutkan.",
		"Silakan pilih salah satu opsi di atas.",
		"Lanjut atau batalkan?",
		"Mau saya lanjutkan ke tahap berikutnya?",
		"Saya sedang menunggu konfirmasi dari Anda.",
	];

	const enQuestions = [
		"Would you like me to refactor the parser too?",
		"Should I proceed with the migration?",
		"Please confirm the target branch before I push.",
		"Do you want the tests in a separate file?",
		"Which option should I take: A or B?",
		"Shall I start with the reducer?",
		"I am waiting for your answer on the schema.",
	];

	for (const text of [...idQuestions, ...enQuestions]) {
		it(`detects a waiting-for-user message: ${text}`, () => {
			assert.equal(isWaitingForUserInput(text), true);
		});
	}

	it("detects a question mark followed by closing markdown emphasis", () => {
		assert.equal(isWaitingForUserInput("Lanjut dengan opsi ini?**"), true);
		assert.equal(isWaitingForUserInput('Pakai nama "reminder"?'), true);
	});

	it("treats a message ending with a period as not waiting when no pattern matches", () => {
		assert.equal(isWaitingForUserInput("Perubahan selesai dan test lulus."), false);
		assert.equal(isWaitingForUserInput("All tests pass and the build is clean."), false);
	});

	it("fails closed and reports waiting for empty or whitespace-only text", () => {
		assert.equal(isWaitingForUserInput(""), true);
		assert.equal(isWaitingForUserInput("   \n\t "), true);
	});

	it("matches patterns case-insensitively", () => {
		assert.equal(isWaitingForUserInput("WOULD YOU LIKE ME TO CONTINUE"), true);
		assert.equal(isWaitingForUserInput("APAKAH BOLEH SAYA LANJUT"), true);
	});

	it("does not treat a plain statement containing a pattern substring as a question", () => {
		assert.equal(isWaitingForUserInput("Saya sudah menulis shall in comment helper."), false);
	});
});

describe("buildReminderMessage", () => {
	it("reports both the in-progress and pending counts in the message", () => {
		const message = buildReminderMessage(2, 1);
		assert.match(message, /\b1 task sedang berjalan\b/);
		assert.match(message, /\b2 task pending\b/);
	});
});
