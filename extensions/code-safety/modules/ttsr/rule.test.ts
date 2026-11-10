import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRules, parseFrontmatter, parseRule } from "./rule.ts";

test("parseFrontmatter memisahkan header yaml-subset dan isi body markdown", () => {
  const md = `---
name: test-rule
action: log
scope: text
---
Ini teks koreksi baris 1
Baris 2
`;
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.name, "test-rule");
  assert.equal(data.action, "log");
  assert.equal(data.scope, "text");
  assert.equal(body, "Ini teks koreksi baris 1\nBaris 2");
});

test("parseRule mengurai rule valid dengan default FR-1 secara lengkap", () => {
  const md = `---
name: empty-validation
description: Cegah basa-basi pembuka
action: strip
scope: text
condition:
  - "^(Tentu|Pasti|Siap)"
---
Langsung jawab inti pertanyaan tanpa basa-basi pembuka.
`;
  const rule = parseRule(md, "empty-val.md");
  assert.equal(rule.name, "empty-validation");
  assert.equal(rule.description, "Cegah basa-basi pembuka");
  assert.equal(rule.action, "strip");
  assert.equal(rule.scope, "text");
  assert.deepEqual(rule.condition, ["^(Tentu|Pasti|Siap)"]);
  assert.equal(rule.flags, "i");
  assert.equal(rule.anchor, "any");
  assert.equal(rule.maxPerTurn, 1);
  assert.equal(rule.enabled, true);
  assert.equal(
    rule.correctionText,
    "Langsung jawab inti pertanyaan tanpa basa-basi pembuka.",
  );
  assert.equal(rule.compiledConditions.length, 1);
  assert.equal(rule.compiledConditions[0].test("Tentu saja"), true);
  assert.equal(rule.compiledConditions[0].test("Tidak"), false);
});

test("parseRule menolak rule tanpa nama", () => {
  const md = `---
action: log
scope: text
condition:
  - "foo"
---
Koreksi
`;
  assert.throws(
    () => parseRule(md, "no-name.md"),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("field 'name' wajib"),
  );
});

test("parseRule menolak rule dengan action tidak dikenal", () => {
  const md = `---
name: bad-action
action: execute_danger
scope: text
condition:
  - "foo"
---
Koreksi
`;
  assert.throws(
    () => parseRule(md, "bad-action.md"),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("action tidak dikenal 'execute_danger'"),
  );
});

test("parseRule menolak rule dengan scope tidak valid", () => {
  const md = `---
name: bad-scope
action: log
scope: invalid-scope
condition:
  - "foo"
---
Koreksi
`;
  assert.throws(
    () => parseRule(md, "bad-scope.md"),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("scope 'invalid-scope' tidak valid"),
  );
});

test("parseRule menolak rule dengan regex condition rusak", () => {
  const md = `---
name: broken-regex
action: log
scope: text
condition:
  - "[a-z"
---
Koreksi
`;
  assert.throws(
    () => parseRule(md, "broken-regex.md"),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("regex condition rusak '[a-z'"),
  );
});

test("parseRule menolak regex unlessUserSays rusak", () => {
  const md = `---
name: broken-unless
action: block
scope: tool:bash
condition:
  - "rm -rf"
unlessUserSays:
  - "(unclosed"
---
Koreksi
`;
  assert.throws(
    () => parseRule(md, "broken-unless.md"),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("regex unlessUserSays rusak '(unclosed'"),
  );
});

test("loadRules memuat seluruh rule valid dan melewati rule rusak serta duplikat", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ttsr-rules-test-"));
  try {
    // Rule valid 1
    writeFileSync(
      join(tempDir, "01-valid.md"),
      `---
name: rule-one
action: log
scope: text
condition:
  - "pola-satu"
---
Koreksi satu
`,
    );

    // Rule rusak (tanpa nama)
    writeFileSync(
      join(tempDir, "02-broken.md"),
      `---
action: log
scope: text
condition:
  - "pola"
---
`,
    );

    // Rule valid 2
    writeFileSync(
      join(tempDir, "03-valid.md"),
      `---
name: rule-two
action: block
scope: tool:bash
condition:
  - "pola-dua"
---
Koreksi dua
`,
    );

    // Rule duplikat nama rule-one
    writeFileSync(
      join(tempDir, "04-duplicate.md"),
      `---
name: rule-one
action: strip
scope: text
condition:
  - "pola-satu-duplikat"
---
`,
    );

    const rules = loadRules(tempDir);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].name, "rule-one");
    assert.equal(rules[0].action, "log");
    assert.equal(rules[1].name, "rule-two");
    assert.equal(rules[1].action, "block");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
