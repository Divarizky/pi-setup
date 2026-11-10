import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { matchToolCondition } from "./guards.ts";
import { createMatcher } from "./matcher.ts";
import { loadRules } from "./rule.ts";
import type { Rule } from "./types.ts";

const RULES_DIR = new URL("./rules", import.meta.url).pathname;

function findRule(rules: Rule[], name: string): Rule {
  const found = rules.find((r) => r.name === name);
  if (!found) {
    throw new Error(`Rule '${name}' tidak ditemukan di ${RULES_DIR}`);
  }
  return found;
}

test("Semua enam rule bawaan terurai tanpa peringatan dan memiliki konfigurasi valid", () => {
  const rules = loadRules(RULES_DIR);
  assert.equal(rules.length, 6, "Harus memuat tepat 6 rule bawaan");

  const expectedNames = [
    "empty-validation",
    "ai-vocabulary",
    "generic-closing",
    "git-commit-push",
    "secret-in-write",
    "tautology-test",
  ];

  for (const name of expectedNames) {
    const r = findRule(rules, name);
    assert.ok(r.correctionText.length > 0, `Rule ${name} harus memiliki teks koreksi`);
    assert.ok(r.compiledConditions.length > 0, `Rule ${name} harus memiliki regex condition`);
  }
});

test("Rule bawaan: empty-validation mendeteksi frasa pembuka dan melewatkan teks biasa", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");
  assert.equal(rule.action, "log");
  assert.equal(rule.scope, "text");

  // Kasus positif dari AGENTS.md
  const matcherPos = createMatcher([rule]);
  const violationsPos = matcherPos.feed(
    "text",
    "You're absolutely right! Berikut adalah implementasi perbaikannya.",
  );
  assert.equal(violationsPos.length, 1);
  assert.equal(violationsPos[0].rule.name, "empty-validation");

  // Kasus negatif (kalimat teknis biasa)
  const matcherNeg = createMatcher([rule]);
  const violationsNeg = matcherNeg.feed(
    "text",
    "Berikut adalah implementasi perbaikan pada fungsi parser.",
  );
  assert.equal(violationsNeg.length, 0);
});

test("Rule bawaan: ai-vocabulary mendeteksi kata terlarang dan melewatkan teks biasa", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "ai-vocabulary");
  assert.equal(rule.action, "log");

  // Kasus positif dari AGENTS.md ("delve", "pivotal", dsb)
  const matcherPos = createMatcher([rule]);
  const violationsPos = matcherPos.feed(
    "text",
    "Mari kita delve ke dalam arsitektur modul ini untuk menemukan masalah.",
  );
  assert.equal(violationsPos.length, 1);
  assert.equal(violationsPos[0].rule.name, "ai-vocabulary");
  assert.equal(violationsPos[0].match.toLowerCase(), "delve");

  // Kasus negatif (kalimat teknis biasa tanpa kosakata AI klise)
  const matcherNeg = createMatcher([rule]);
  const violationsNeg = matcherNeg.feed(
    "text",
    "Mari kita telusuri alur fungsi parseRule untuk memastikan validasi berjalan.",
  );
  assert.equal(violationsNeg.length, 0);
});

test("Rule bawaan: generic-closing mendeteksi penutup klise dan melewatkan teks biasa", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "generic-closing");
  assert.equal(rule.action, "log");

  // Kasus positif
  const matcherPos = createMatcher([rule]);
  const violationsPos = matcherPos.feed(
    "text",
    "Semua perubahan telah selesai dibuat. Semoga membantu pekerjaan Anda!",
  );
  assert.equal(violationsPos.length, 1);
  assert.equal(violationsPos[0].rule.name, "generic-closing");

  // Kasus negatif
  const matcherNeg = createMatcher([rule]);
  const violationsNeg = matcherNeg.feed(
    "text",
    "Semua tes unit lulus dengan exit code 0.",
  );
  assert.equal(violationsNeg.length, 0);
});

test("Rule bawaan: git-commit-push mendeteksi git commit/push dan melewatkan perintah biasa", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "git-commit-push");
  assert.equal(rule.action, "block");
  assert.equal(rule.scope, "tool:bash");

  // Kasus positif dari AGENTS.md ("git commit -m x")
  const posInput = JSON.stringify({ command: "git commit -m 'perubahan penting'" });
  const posMatch = matchToolCondition(rule, posInput);
  assert.equal(posMatch.matched, true);
  assert.match(posMatch.excerpt ?? "", /git\s+commit/);

  // Kasus positif push
  const pushInput = JSON.stringify({ command: "git push origin main" });
  const pushMatch = matchToolCondition(rule, pushInput);
  assert.equal(pushMatch.matched, true);

  // Kasus negatif (perintah git non-commit atau non-push)
  const statusInput = JSON.stringify({ command: "git status --short" });
  assert.equal(matchToolCondition(rule, statusInput).matched, false);

  const testInput = JSON.stringify({ command: "npm test" });
  assert.equal(matchToolCondition(rule, testInput).matched, false);
});

test("Rule bawaan: secret-in-write mendeteksi penulisan secret/token dan melewatkan konten biasa", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "secret-in-write");
  assert.equal(rule.action, "block");

  // Kasus positif: API key format sk- atau generic secret
  const secretInput = JSON.stringify({
    path: ".env",
    content: "sk-proj-1234567890abcdef1234567890abcdef",
  });
  const matchSecret = matchToolCondition(rule, secretInput);
  assert.equal(matchSecret.matched, true);

  const tokenInput = JSON.stringify({
    path: "config.json",
    content: 'apiKey: "12345678abcdefgh"',
  });
  assert.equal(matchToolCondition(rule, tokenInput).matched, true);

  // Kasus negatif: konten kode biasa tanpa secret
  const normalInput = JSON.stringify({
    path: "src/main.ts",
    content: "export const serverPort = 8080;\nconsole.log(serverPort);",
  });
  assert.equal(matchToolCondition(rule, normalInput).matched, false);
});

test("Rule bawaan: tautology-test mendeteksi tes tautologi dan melewatkan tes semantik", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "tautology-test");
  assert.equal(rule.action, "log");

  // Kasus positif: expect(true).toBe(true) pada file *.test.*
  const tautologyInput = JSON.stringify({
    path: "src/utils.test.ts",
    content: "test('dummy', () => { expect(true).toBe(true); });",
  });
  const matchTautology = matchToolCondition(rule, tautologyInput);
  assert.equal(matchTautology.matched, true);

  // Kasus negatif 1: pengujian semantik nyata pada file test
  const realTestInput = JSON.stringify({
    path: "src/utils.test.ts",
    content: "test('hitung', () => { expect(add(1, 2)).toBe(3); });",
  });
  assert.equal(matchToolCondition(rule, realTestInput).matched, false);

  // Kasus negatif 2: berkas non-test tidak boleh dipicu
  const nonTestInput = JSON.stringify({
    path: "src/utils.ts",
    content: "const a = expect(true).toBe(true);",
  });
  assert.equal(matchToolCondition(rule, nonTestInput).matched, false);
});
