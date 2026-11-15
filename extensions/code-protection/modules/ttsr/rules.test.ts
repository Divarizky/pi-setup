import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { matchToolCondition } from "./guards.ts";
import { createMatcher } from "./matcher.ts";
import { loadRules } from "./rule.ts";
import type { Rule } from "./types.ts";

const RULES_DIR = fileURLToPath(new URL("./rules", import.meta.url));

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
  assert.equal(rule.action, "abort");
  assert.equal(rule.scope, "text");
  assert.equal(rule.anchor, "start");
  assert.equal(rule.repeat, "after-gap");
  assert.equal(rule.repeatGap, 6);

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

test("Rule bawaan: empty-validation memicu pada Perfect dan Exactly bertanda baca di awal", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");

  const perfect = createMatcher([rule]).feed("text", "Perfect! Berikut perbaikannya.");
  assert.equal(perfect.length, 1);
  assert.equal(perfect[0].rule.name, "empty-validation");

  const exactly = createMatcher([rule]).feed("text", "Exactly, masalahnya ada di parser.");
  assert.equal(exactly.length, 1);
  assert.equal(exactly[0].rule.name, "empty-validation");
});

test("Rule bawaan: empty-validation tidak memicu false positive pada pembuka teknis", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");

  const files = createMatcher([rule]).feed("text", "Exactly 3 files changed.");
  assert.equal(files.length, 0);

  const match = createMatcher([rule]).feed("text", "Perfect match on line 10.");
  assert.equal(match.length, 0);
});

test("Rule bawaan: empty-validation mendeteksi frasa pembuka Bahasa Indonesia dan melewatkan pembuka teknis", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");

  // Kasus positif: frasa validasi kosong di awal teks
  const positives = [
    "Benar sekali, saya akan perbaiki kodenya.",
    "Anda benar sekali! Masalahnya di parser.",
    "Tepat sekali! Berikut langkah perbaikannya.",
    "Pertanyaan yang sangat bagus! Mari kita bedah.",
    "Ide cemerlang! Kita terapkan sekarang.",
    "Sangat masuk akal, implementasinya seperti ini.",
  ];
  for (const text of positives) {
    const violations = createMatcher([rule]).feed("text", text);
    assert.equal(violations.length, 1, `harus memicu: ${text}`);
    assert.equal(violations[0].rule.name, "empty-validation");
  }

  // Kasus negatif: pembuka teknis Bahasa Indonesia yang normal
  const negatives = [
    "Benar bahwa berkas auth.ts perlu diubah.",
    "Tepat pada baris 42 terdapat error.",
    "Pertanyaan berikut belum terjawab.",
  ];
  for (const text of negatives) {
    const violations = createMatcher([rule]).feed("text", text);
    assert.equal(violations.length, 0, `tidak boleh memicu: ${text}`);
  }
});

test("Rule bawaan: empty-validation streaming tidak memicu dari token kata saja (false positive $)", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");

  // Chunk pertama berupa kata saja: tanpa tanda baca tidak boleh memicu.
  const exactly = createMatcher([rule]);
  const exactlyViolations = [
    ...exactly.feed("text", "Exactly"),
    ...exactly.feed("text", " 3 files changed."),
  ];
  assert.equal(exactlyViolations.length, 0);

  const perfect = createMatcher([rule]);
  assert.equal(perfect.feed("text", "Perfect").length, 0);
});

test("Rule bawaan: empty-validation streaming memicu saat tanda baca tiba di chunk kedua", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");

  // Exactly lalu ", ...": pemicu tepat pada chunk kedua.
  const exactly = createMatcher([rule]);
  const exactlyViolations = [
    ...exactly.feed("text", "Exactly"),
    ...exactly.feed("text", ", masalahnya di sini."),
  ];
  assert.equal(exactlyViolations.length, 1);
  assert.equal(exactlyViolations[0].rule.name, "empty-validation");

  // Perfect lalu "! ...": pemicu tepat pada chunk kedua.
  const perfect = createMatcher([rule]);
  const perfectViolations = [
    ...perfect.feed("text", "Perfect"),
    ...perfect.feed("text", "! Berikut perbaikannya."),
  ];
  assert.equal(perfectViolations.length, 1);
  assert.equal(perfectViolations[0].rule.name, "empty-validation");
});

test("Rule bawaan: empty-validation dengan anchor start mengabaikan frasa di tengah teks", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");
  const matcher = createMatcher([rule]);

  const technical = matcher.feed("text", "Parser sudah diperbaiki dan semua tes lulus. ");
  assert.equal(technical.length, 0);

  const midText = matcher.feed("text", "You're absolutely right, tapi ini tetap di tengah.");
  assert.equal(midText.length, 0);
});

test("Rule bawaan: empty-validation repeat after-gap dengan repeatGap 6 menahan pemicu ulang", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "empty-validation");
  const matcher = createMatcher([rule]);
  const phrase = "You're absolutely right! Berikut perbaikannya.";

  // Giliran 0: pemicu pertama
  assert.equal(matcher.feed("text", phrase).length, 1);

  // Giliran 1..5: pemicu ulang harus diblokir
  for (let turn = 1; turn <= 5; turn++) {
    matcher.endTurn();
    matcher.reset();
    assert.equal(
      matcher.feed("text", phrase).length,
      0,
      `giliran ${turn} belum boleh memicu ulang`,
    );
  }

  // Giliran 6: pemicu ulang diizinkan
  matcher.endTurn();
  matcher.reset();
  assert.equal(matcher.feed("text", phrase).length, 1);
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

test("Rule bawaan: secret-in-write hanya mencakup write, edit, dan hash_edit", () => {
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "secret-in-write");
  assert.deepEqual(
    rule.scope.split(",").map((s) => s.trim()),
    ["tool:write", "tool:edit", "tool:hash_edit"],
  );
});

test("Matcher: secret-in-write tidak memicu pada scope tool:bash", () => {
  // Mencegah false positive: perintah bash pengujian autentikasi tidak boleh terblokir.
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "secret-in-write");
  const matcher = createMatcher([rule]);
  const violations = matcher.feed(
    "tool:bash",
    JSON.stringify({ command: "node --test auth.test.ts # password: verifikasi-alur-login" }),
  );
  assert.equal(violations.length, 0);
});

test("Matcher: secret-in-write memicu pada scope tool:write, tool:edit, dan tool:hash_edit", () => {
  // Mencegah regresi: penyempitan scope tidak boleh melepas perlindungan tool penulisan.
  const rules = loadRules(RULES_DIR);
  const rule = findRule(rules, "secret-in-write");
  const payload = JSON.stringify({ path: ".env", content: "API_KEY=abcdefgh12345678" });
  for (const scope of ["tool:write", "tool:edit", "tool:hash_edit"]) {
    const matcher = createMatcher([rule]);
    const violations = matcher.feed(scope, payload);
    assert.equal(violations.length, 1, `scope ${scope} harus memicu secret-in-write`);
  }
});
