import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLineHash,
  detectNewline,
  applyHashEditToText,
  resolveAnchors,
  splitLines,
} from "./core.ts";

test("computeLineHash: normalisasi trailing whitespace dan \\r", () => {
  const h1 = computeLineHash("const x = 10;");
  const h2 = computeLineHash("const x = 10;  \t");
  const h3 = computeLineHash("const x = 10;\r");
  assert.equal(h1.length, 6);
  assert.equal(h1, h2);
  assert.equal(h1, h3);
});

test("detectNewline: deteksi CRLF vs LF dengan benar", () => {
  assert.equal(detectNewline("line1\r\nline2\r\nline3"), "\r\n");
  assert.equal(detectNewline("line1\nline2\nline3"), "\n");
  assert.equal(detectNewline("line1"), "\n");
});

test("applyHashEditToText: penggantian baris eksak sukses", () => {
  const original = [
    "function hello() {",
    "  console.log('first');",
    "  console.log('target');",
    "  console.log('last');",
    "}",
  ].join("\n");

  const lines = splitLines(original);
  const startAnchor = { line: 3, hash: computeLineHash(lines[2]) }; // "  console.log('target');"
  const endAnchor = { line: 3, hash: computeLineHash(lines[2]) };

  const result = applyHashEditToText(
    original,
    startAnchor,
    endAnchor,
    "  console.log('replaced');\n  console.log('injected');"
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.drift, 0);
    assert.match(result.resultContent, /console\.log\('replaced'\);/);
    assert.match(result.resultContent, /console\.log\('injected'\);/);
    assert.ok(!result.resultContent.includes("console.log('target');"));
  }
});

test("applyHashEditToText: toleransi pergeseran baris simetris (delta drift)", () => {
  // Simulasi berkas telah bergeser +2 baris ke bawah karena penambahan baris sebelumnya
  const shiftedDoc = [
    "// new header comment 1",
    "// new header comment 2",
    "function calculate() {",
    "  const a = 1;",
    "  const b = 2;",
    "  return a + b;",
    "}",
  ].join("\n");

  // Pemanggil masih mengira `const a = 1;` berada di line 2 dan `const b = 2;` di line 3 (sebelum +2 lines dimasukkan)
  const originalHashA = computeLineHash("  const a = 1;");
  const originalHashB = computeLineHash("  const b = 2;");

  const startAnchor = { line: 2, hash: originalHashA };
  const endAnchor = { line: 3, hash: originalHashB };

  const result = applyHashEditToText(
    shiftedDoc,
    startAnchor,
    endAnchor,
    "  const a = 100;\n  const b = 200;"
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.drift, 2); // bergeser +2 baris
    assert.match(result.resultContent, /const a = 100;/);
    assert.match(result.resultContent, /const b = 200;/);
    assert.match(result.resultContent, /\/\/ new header comment 1/);
  }
});

test("applyHashEditToText: tolak edit jika hash meleset dan kembalikan konteks cuplikan", () => {
  const doc = [
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
  ].join("\n");

  const startAnchor = { line: 2, hash: "deadbf" }; // Hash ngawur
  const endAnchor = { line: 2, hash: "deadbf" };

  const result = applyHashEditToText(doc, startAnchor, endAnchor, "const b = 20;");
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.reason, /(meleset|tidak cocok)/);
    assert.ok(result.contextSnippet);
    assert.match(result.contextSnippet, /const b = 2;/);
  }
});
