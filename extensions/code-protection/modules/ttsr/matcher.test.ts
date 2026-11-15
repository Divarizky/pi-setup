import assert from "node:assert/strict";
import test from "node:test";
import { createMatcher } from "./matcher.ts";
import { parseRule } from "./rule.ts";

test("pola yang terpotong di dua delta tetap terdeteksi", () => {
  const rule = parseRule(`---
name: cross-delta-pattern
action: log
scope: text
condition:
  - "koreksi manual"
---
`);

  const matcher = createMatcher([rule]);

  const v1 = matcher.feed("text", "Bagian ini butuh kor");
  assert.equal(v1.length, 0);

  const v2 = matcher.feed("text", "eksi manual segera.");
  assert.equal(v2.length, 1);
  assert.equal(v2[0].rule.name, "cross-delta-pattern");
  assert.equal(v2[0].match, "koreksi manual");
  assert.deepEqual(v2[0].range, { start: 17, end: 31 });
});

test("pola di luar jendela buffer tidak terdeteksi saat potongan awal sudah terbuang", () => {
  const rule = parseRule(`---
name: window-test
action: log
scope: text
condition:
  - "target_pola_panjang"
---
`);

  // Batasi ukuran jendela sliding buffer ke 10 karakter
  const matcher = createMatcher([rule], { windowSize: 10 });

  // Delta 1 memuat awalan "target_" (7 karakter)
  matcher.feed("text", "target_");

  // Masukkan delta pengisi panjang yang mendorong buffer keluar dari jendela
  matcher.feed("text", "1234567890abcdefghij");

  // Sekarang potongan akhiran "pola_panjang" masuk
  // Karena "target_" sudah tergeser keluar dari jendela 10 karakter terakhir,
  // pola lengkap "target_pola_panjang" tidak bisa terbentuk
  const v = matcher.feed("text", "pola_panjang");
  assert.equal(v.length, 0);
  assert.equal(matcher.getTriggerCount("window-test"), 0);
});

test("maxPerTurn membatasi pelanggaran dan reset tidak menghapus riwayat pemicu once", () => {
  const rule = parseRule(`---
name: limit-once
action: log
scope: text
maxPerTurn: 1
condition:
  - "banned"
---
`);

  const matcher = createMatcher([rule]);

  // Sekalipun muncul 3 kali dalam satu delta atau berurutan, hanya 1 yang dilaporkan
  const v1 = matcher.feed("text", "banned banned banned");
  assert.equal(v1.length, 1);
  assert.equal(matcher.getTriggerCount("limit-once"), 1);

  // Delta berikutnya dalam giliran sama tidak memicu lagi
  const v2 = matcher.feed("text", " banned lagi");
  assert.equal(v2.length, 0);

  // Reset membuka giliran baru untuk maxPerTurn, tetapi rule once yang sudah memicu tetap diam
  matcher.reset();
  assert.equal(matcher.getTriggerCount("limit-once"), 0);

  const v3 = matcher.feed("text", "banned di giliran baru");
  assert.equal(v3.length, 0);

  // Matcher baru dibuat ulang: rule once memicu lagi
  const fresh = createMatcher([rule]);
  const v4 = fresh.feed("text", "banned di sesi baru");
  assert.equal(v4.length, 1);
});

test("anchor start hanya cocok pada awal respons", () => {
  const startRule = parseRule(`---
name: empty-val-start
action: strip
scope: text
anchor: start
condition:
  - "Tentu( saja)?"
---
`);

  // Kasus 1: Muncul persis di awal respons
  const m1 = createMatcher([startRule]);
  const v1 = m1.feed("text", "Tentu saja! Ini solusi Anda.");
  assert.equal(v1.length, 1);
  assert.equal(v1[0].match, "Tentu saja");

  // Kasus 2: Muncul setelah leading whitespace di awal respons
  const m2 = createMatcher([startRule]);
  const v2 = m2.feed("text", "  \n  Tentu, ini solusi Anda.");
  assert.equal(v2.length, 1);
  assert.equal(v2[0].match, "Tentu");

  // Kasus 3: Muncul di tengah respons (bukan awal) tidak boleh cocok
  const m3 = createMatcher([startRule]);
  m3.feed("text", "Berikut adalah analisis awal: ");
  const v3 = m3.feed("text", "Tentu saja ada kesalahan.");
  assert.equal(v3.length, 0);

  // Kasus 4: Muncul di awal delta tetapi stream sudah memiliki karakter sebelumnya
  const m4 = createMatcher([startRule]);
  const v4a = m4.feed("text", "Halo dunia.");
  assert.equal(v4a.length, 0);
  const v4b = m4.feed("text", " Tentu saja tidak boleh kena.");
  assert.equal(v4b.length, 0);
});

test("rule once tidak memicu lagi di giliran berikutnya walau pola muncul kembali", () => {
  // Mencegah: koreksi yang sama diulang tiap giliran dan membuang konteks
  const rule = parseRule(`---
name: once-rule
action: strip
scope: text
condition:
  - "basa-basi"
---
`);
  const matcher = createMatcher([rule]);

  const turn1 = matcher.feed("text", "Ini basa-basi pertama.");
  assert.equal(turn1.length, 1);
  matcher.endTurn();
  matcher.reset();

  const turn2 = matcher.feed("text", "Ini basa-basi lagi.");
  assert.equal(turn2.length, 0);
});

test("rule after-gap dengan repeatGap 2 memicu lagi tepat setelah dua giliran selesai", () => {
  // Mencegah: gap dihitung salah sehingga koreksi terlalu sering atau tidak pernah kembali
  const rule = parseRule(`---
name: gap-rule
action: strip
scope: text
repeat: after-gap
repeatGap: 2
condition:
  - "basa-basi"
---
`);
  const matcher = createMatcher([rule]);

  const turn1 = matcher.feed("text", "basa-basi giliran satu");
  assert.equal(turn1.length, 1);
  matcher.endTurn();
  matcher.reset();

  const turn2 = matcher.feed("text", "basa-basi giliran dua");
  assert.equal(turn2.length, 0);
  matcher.endTurn();
  matcher.reset();

  const turn3 = matcher.feed("text", "basa-basi giliran tiga");
  assert.equal(turn3.length, 1);
});

test("rule block memicu di setiap giliran tanpa batas repeat", () => {
  // Mencegah: kebijakan repeat ikut membatasi aksi block yang harus selalu ditegakkan
  const rule = parseRule(`---
name: block-rule
action: block
scope: tool:bash
condition:
  - "rm -rf"
---
`);
  const matcher = createMatcher([rule]);

  for (let turn = 1; turn <= 3; turn++) {
    const v = matcher.feed("tool:bash", "rm -rf /tmp/x");
    assert.equal(v.length, 1, `giliran ${turn} harus memicu`);
    matcher.endTurn();
    matcher.reset();
  }
});
