import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TtsrStateManager } from "./state.ts";

test("TtsrStateManager menangani berkas belum ada dan mengembalikan default", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-state-test-"));
  const statePath = join(tmp, "ttsr-state.json");

  try {
    const manager = new TtsrStateManager(statePath);
    assert.equal(manager.isEnabled("any-rule"), true);
    assert.equal(manager.isEnabled("any-rule", false), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("TtsrStateManager menyimpan perubahan on/off dan bertahan saat dimuat ulang dari disk", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-state-test-"));
  const statePath = join(tmp, "nested", "ttsr-state.json");

  try {
    const manager1 = new TtsrStateManager(statePath);
    manager1.setRuleEnabled("git-commit-push", false);
    manager1.setRuleEnabled("empty-validation", true);

    assert.equal(manager1.isEnabled("git-commit-push"), false);
    assert.equal(manager1.isEnabled("empty-validation"), true);

    // Muat ulang instansi baru dari disk
    const manager2 = new TtsrStateManager(statePath);
    assert.equal(manager2.isEnabled("git-commit-push"), false);
    assert.equal(manager2.isEnabled("empty-validation"), true);
    assert.equal(manager2.isEnabled("unknown-rule"), true);

    // Ubah kembali jadi true
    manager2.setRuleEnabled("git-commit-push", true);

    // Instansi ketiga mengecek state terbaru
    const manager3 = new TtsrStateManager(statePath);
    assert.equal(manager3.isEnabled("git-commit-push"), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("TtsrStateManager tahan terhadap berkas JSON korup", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-state-test-"));
  const statePath = join(tmp, "ttsr-state.json");

  try {
    writeFileSync(statePath, "{ broken json content ...", "utf8");
    const manager = new TtsrStateManager(statePath);
    // Tidak melempar error dan fallback ke default
    assert.equal(manager.isEnabled("rule-x"), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
