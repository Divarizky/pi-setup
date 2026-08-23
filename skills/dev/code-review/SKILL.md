---
name: code-review
description: "Review diff sejak fixed point (commit/branch/tag, atau \"none\" untuk repo baru) 2 axis — Standards dan Spec — paralel sub-agent, tidak saling polusi. Trigger: \"review perubahan ini\", \"cek diff sejak X\", \"vet sebelum commit\"."
disable-model-invocation: true
---

# Code Review

Dua axis review, dijalankan terpisah supaya tidak saling pengaruh:

- **Standards** — kode ikuti konvensi project?
- **Spec** — kode implementasi sesuai issue/PRD asal?

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — izinkan lanjut dengan warning. Universal mode selalu menampilkan hasil review di chat dan tidak membuat artifact workflow; Project-aware mode boleh membaca sumber `.workspace` yang tersedia.

### Dipanggil dari Chain (implement)

Spec + fixed point + diff range sudah di konteks → Step 2 opsi 1 (inline dari caller) trigger duluan.

## Step 1 — Validasi Fixed Point

- **Commit hash**: `git rev-parse <fixed-point>` — gagal → tanya user, stop
- **`none`** (repo baru): diff vs empty tree `4b825dc642cb6eb9a060e54bf899d1530363a3b7`. Error = semua file new, sub-agent review manual tanpa diff context.

Diff kosong → stop, beri tahu user tidak ada perubahan.

## Step 2 — Cari Sumber Spec (prioritas, stop kalau ketemu)

1. **Inline dari caller** — dipanggil dari `implement`: Detail + Done criteria di konteks
2. **File PRD** — Project-aware: `.workspace/.scratch/<slug>/PRD.md` (slug = segment terakhir branch: `feature/user-auth` → `user-auth`)
3. **Detail task** — Project-aware: `.workspace/.scratch/<slug>/tasks.md` (format: `## Queue`/`## In Progress`/`## Done`, ambil `Detail:`)
4. **Path dari user** — validasi file exists/readable. Invalid → kembali ke sumber sebelumnya

Universal mode tidak mengasumsikan PRD/tasks `.workspace`; gunakan inline spec, file yang user berikan, atau laporkan "no spec available".

Tidak ketemu → tanya user. User bilang tidak ada → sub-agent Spec skip, laporkan "no spec available".

## Step 3 — Cari Sumber Standards

Gunakan Context Resolver. Cari file dokumentasi coding style (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, dll) jika tersedia.

**Gold standard file** (Project-aware dari AGENT.md frontmatter `style_reference_path`):
- Parse YAML frontmatter AGENT.md jika tersedia → `style_reference_path`
- File exists → baseline pembanding axis Standards
- Universal mode: gunakan style reference hanya jika user memberi path atau ada konvensi project yang jelas; jangan membuat asumsi

**Smell baseline** (selalu bawa, Fowler *Refactoring* ch.3):
- Speculative Generality → hapus, inline sampai kebutuhan nyata
- Message Chains (`a.b().c().d()`) → sembunyikan di balik 1 method
- Middle Man (delegasi saja) → potong, panggil target langsung
- Refused Bequest (abaikan warisan) → drop inheritance, pakai composition

## Step 4 — Jalankan Paralel

Satu pesan, dua sub-agent (general-purpose), tanpa saling lihat konteks:

**Sub-agent Standards** dapat: full diff + commit list (kosong kalau `none`), standards file, smell baseline, gold standard file (kalau ada).
Brief: laporkan per file/hunk langgar standard terdokumentasi (kutip sumber+rule) + smell baseline terdeteksi. Kalau gold standard ada, bandingkan gaya coding — flag perbedaan style signifikan saja. Bedakan hard violation vs judgement call. Skip yang sudah dihandle tooling. **<400 kata**.

**Sub-agent Spec** dapat: full diff + commit list, spec path/isi (termasuk `Done:`).
Brief: laporkan (a) requirement hilang/parsial, (b) behavior tidak diminta (scope creep), (c) requirement kelihatan diimplement tapi salah, (d) **Done criteria** terpenuhi/tidak. Kutip baris spec tiap temuan. **<400 kata**.

**Fallback Sequential**: Standards dulu → laporkan → Spec. Output tetap dipisah heading `## Standards` / `## Spec`, jangan merge.

### Error Handling Sub-Agent

Salah satu gagal → jangan block total. Laporkan partial: "Standards: [result], Spec: [error]". Tetap tampilkan heading keduanya — yang gagal isi pesan error.

## Step 5 — Aggregasi

Tampilkan dua laporan di `## Standards` dan `## Spec`, verbatim/sedikit dirapikan. **Jangan merge/re-rank** — dua axis sengaja dipisah.

Universal mode: tampilkan kedua laporan lengkap di chat, lalu tambahkan:

```text
Mode: Universal
Persistence: chat-only
Status: review-complete | partial | blocked
Spec: available | no spec available
Next Step: <aksi yang disarankan, tanpa auto-apply>
```

Jangan menulis hasil review ke file dalam Universal mode. Jika salah satu sub-agent gagal, gunakan `Status: partial` dan tampilkan error di axis terkait.

## Saran Skills Lain

[Workflow](../WORKFLOW.md) — Belum ada diff → kerjakan perubahan dulu. Hanya 1 axis → jalanin utuh (axis lain report "tidak ada data"). Butuh deepening arsitektur → `improve-architecture`.