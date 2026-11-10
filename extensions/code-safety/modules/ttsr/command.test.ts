import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleTtsrCommand, registerTtsrCommand } from "./command.ts";
import { appendViolationLog } from "./log.ts";
import { parseRule } from "./rule.ts";
import { TtsrStateManager } from "./state.ts";
import type { Rule } from "./types.ts";

function createMockRule(name: string, action = "log", scope = "text"): Rule {
  const md = [
    "---",
    `name: ${name}`,
    `action: ${action}`,
    `scope: ${scope}`,
    "condition:",
    "  - test-pattern",
    "---",
    "Pesan koreksi",
  ].join("\n");
  return parseRule(md, `${name}.md`);
}

test("handleTtsrCommand list menampilkan seluruh rule dan statusnya", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-cmd-test-"));
  const statePath = join(tmp, "ttsr-state.json");

  try {
    const rules = [
      createMockRule("empty-validation", "log", "text"),
      createMockRule("git-commit-push", "block", "tool:bash"),
    ];

    const stateManager = new TtsrStateManager(statePath);
    stateManager.setRuleEnabled("git-commit-push", false);

    const out = handleTtsrCommand("list", { rules: () => rules, getRules: () => rules, stateManager });
    assert.equal(out.level, "info");
    assert.match(out.text, /empty-validation \[log\/text\]: on/);
    assert.match(out.text, /git-commit-push \[block\/tool:bash\]: off/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("handleTtsrCommand on dan off mengubah status rule dan menolak rule tak dikenal", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-cmd-test-"));
  const statePath = join(tmp, "ttsr-state.json");

  try {
    const rules = [createMockRule("rule-1", "log", "text")];
    const stateManager = new TtsrStateManager(statePath);
    const deps = { getRules: () => rules, stateManager };

    // Matikan rule-1
    const offRes = handleTtsrCommand("off rule-1", deps);
    assert.equal(offRes.level, "info");
    assert.match(offRes.text, /dinonaktifkan/);
    assert.equal(stateManager.isEnabled("rule-1"), false);

    // Hidupkan kembali rule-1
    const onRes = handleTtsrCommand("on rule-1", deps);
    assert.equal(onRes.level, "info");
    assert.match(onRes.text, /berhasil diaktifkan/);
    assert.equal(stateManager.isEnabled("rule-1"), true);

    // Rule tidak dikenal
    const unknownOff = handleTtsrCommand("off rule-hantu", deps);
    assert.equal(unknownOff.level, "error");
    assert.match(unknownOff.text, /Rule 'rule-hantu' tidak ditemukan/);

    const unknownOn = handleTtsrCommand("on rule-hantu", deps);
    assert.equal(unknownOn.level, "error");
    assert.match(unknownOn.text, /Rule 'rule-hantu' tidak ditemukan/);

    // Argumen kosong
    const emptyArgs = handleTtsrCommand("on", deps);
    assert.equal(emptyArgs.level, "error");
    assert.match(emptyArgs.text, /Format salah/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("handleTtsrCommand stats menampilkan statistik pelanggaran dan retry urut retry", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-cmd-test-"));
  const statePath = join(tmp, "ttsr-state.json");
  const logPath = join(tmp, "ttsr-log.jsonl");

  try {
    const rules = [createMockRule("rule-a"), createMockRule("rule-b")];
    const stateManager = new TtsrStateManager(statePath);
    const deps = { getRules: () => rules, stateManager, logPath };

    // Saat log masih kosong
    const emptyStats = handleTtsrCommand("stats", deps);
    assert.equal(emptyStats.level, "info");
    assert.match(emptyStats.text, /Belum ada catatan pelanggaran/);

    // Tulis beberapa log
    appendViolationLog(
      { ts: 1, rule: "rule-a", action: "log", scope: "text", retry: false },
      logPath,
    );
    appendViolationLog(
      { ts: 2, rule: "rule-a", action: "log", scope: "text", retry: false },
      logPath,
    );
    appendViolationLog(
      { ts: 3, rule: "rule-b", action: "abort", scope: "text", retry: true },
      logPath,
    );

    const statsRes = handleTtsrCommand("stats", deps);
    assert.equal(statsRes.level, "info");
    const lines = statsRes.text.split("\n");
    // rule-b harus tampil duluan karena 1 retry > 0 retry
    assert.match(lines[1], /rule-b: 1 pelanggaran, 1 retry koreksi/);
    assert.match(lines[2], /rule-a: 2 pelanggaran, 0 retry koreksi/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("registerTtsrCommand mendaftarkan command handler ke ExtensionAPI Pi", async () => {
  let registeredName = "";
  let registeredOptions: any = null;

  const mockPi: any = {
    registerCommand(name: string, options: any) {
      registeredName = name;
      registeredOptions = options;
    },
  };

  const notifications: Array<{ text: string; level: string }> = [];
  const mockCtx: any = {
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  };

  const tmp = mkdtempSync(join(tmpdir(), "ttsr-cmd-reg-"));
  try {
    const rules = [createMockRule("sample-rule")];
    const stateManager = new TtsrStateManager(join(tmp, "ttsr-state.json"));
    registerTtsrCommand(mockPi, { getRules: () => rules, stateManager });

    assert.equal(registeredName, "ttsr");
    assert.ok(registeredOptions?.handler);

    await registeredOptions.handler("list", mockCtx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /sample-rule/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
