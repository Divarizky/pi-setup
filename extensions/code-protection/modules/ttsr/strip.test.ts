import assert from "node:assert/strict";
import test from "node:test";
import { stripViolations } from "./strip.ts";
import type { Violation } from "./types.ts";

test("stripViolations menghapus kalimat pembuka yang cocok dan mempertahankan sisa teks", () => {
  const original =
    "Tentu saja! Berikut adalah panduan konfigurasinya:\n- Langkah satu\n- Langkah dua";

  const matches: Violation[] = [
    {
      rule: {
        name: "empty-val",
        action: "strip",
        scope: "text",
        condition: ["Tentu saja! "],
        flags: "i",
        anchor: "start",
        maxPerTurn: 1,
        enabled: true,
        correctionText: "",
        compiledConditions: [/Tentu saja! /i],
      },
      match: "Tentu saja! ",
      range: { start: 0, end: 12 },
      scope: "text",
    },
  ];

  const stripped = stripViolations(original, matches);
  assert.equal(
    stripped,
    "Berikut adalah panduan konfigurasinya:\n- Langkah satu\n- Langkah dua",
  );
});

test("stripViolations menghapus beberapa pelanggaran tanpa merusak teks di sekitarnya", () => {
  const original = "Alpha [HAPUS_1] Beta [HAPUS_2] Gamma.";
  const matches = [
    {
      range: { start: 6, end: 16 },
      match: "[HAPUS_1] ",
    },
    {
      range: { start: 21, end: 31 },
      match: "[HAPUS_2] ",
    },
  ];

  const stripped = stripViolations(original, matches);
  assert.equal(stripped, "Alpha Beta Gamma.");
});

test("stripViolations menggabungkan rentang yang tumpang tindih secara aman", () => {
  const original = "0123456789ABCDEF";
  const matches = [
    { range: { start: 4, end: 10 }, match: "456789" },
    { range: { start: 8, end: 12 }, match: "89AB" },
  ];

  // Range 4..12 harus terhapus, sisa "0123" + "CDEF"
  const stripped = stripViolations(original, matches);
  assert.equal(stripped, "0123CDEF");
});

test("stripViolations mengembalikan teks asli bila daftar matches kosong", () => {
  const original = "Teks ini tetap utuh sama sekali.";
  const stripped = stripViolations(original, []);
  assert.equal(stripped, original);
});
