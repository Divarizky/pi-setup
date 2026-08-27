---
name: code-review
description: 'Review diff dari sumber eksplisit: staged, fixed point (commit/branch/tag), atau none untuk repo baru. 2 axis — Standards dan Spec — paralel sub-agent, tidak saling polusi. Trigger: "review perubahan ini", "cek diff sejak X", "vet sebelum commit".'
disable-model-invocation: true
---

# Code Review

Dua axis review, dijalankan terpisah supaya tidak saling pengaruh:

- **Standards** — kode ikuti konvensi project?
- **Spec** — kode implementasi sesuai issue/requirements asal?

## Diff Source

Ditentukan eksplisit oleh caller — satu dari:

| Sumber          | Isi                                  | Kapan                                                        |
| --------------- | ------------------------------------ | ------------------------------------------------------------ |
| `staged`        | `git diff --staged`                  | Chain dari `implement`/`git-commit` — perubahan belum commit |
| `<fixed-point>` | `git diff <ref>` — commit/branch/tag | Review rentang sejak ref tertentu, diminta user              |
| `none`          | Semua file diperlakukan sebagai baru | Repo baru tanpa commit                                       |

Tanpa konteks caller dan user tidak menyebut → tanya user sebelum jalan.

## Prerequisites

[Prerequisites](../shared/COMMON.md#prerequisites) — izinkan lanjut dengan warning. Universal mode selalu menampilkan hasil review di chat dan tidak membuat artifact workflow; Project mode boleh membaca sumber `.workspace` yang tersedia.

### Called from Chain (implement)

Spec + sumber diff sudah di konteks → sumber default `staged`, Step 2 opsi 1 (inline dari caller) trigger duluan.

## Step 1 — Validate Diff Source

- **`staged`**: wajib ada staged changes (`git diff --staged --quiet` exit code 1). Kosong → stop, beri tahu user tidak ada perubahan.
- **`<fixed-point>`**: `git rev-parse <fixed-point>` — gagal → tanya user, stop.
- **`none`** (repo baru): semua file diperlakukan sebagai file baru; berikan daftar file ke kedua sub-agent tanpa diff context.

Diff kosong → stop, beri tahu user tidak ada perubahan.

### Staged Completeness Pre-Check (source `staged`)

Pastikan seluruh perubahan masuk staged, bukan cuma sebagian:

```bash
git status --porcelain
```

- Kolom kedua bukan spasi (contoh ` M`, `MM`, `AM`) → ada modifikasi belum di-stage
- Baris `??` → ada file untracked

Salah satu ketemu → jangan langsung review. Tampilkan daftar filenya, tanya user: stage dulu atau lanjut review staged-only. File untracked tidak boleh di-stage otomatis — bisa berisi secret atau config lokal.

## Step 2 — Find Spec Source (priority, stop when found)

1. **Inline dari caller** — dipanggil dari `implement`: Detail + Done criteria di konteks
2. **File requirements** — Project: `.workspace/.scratch/<slug>/requirements.md` (slug = segment terakhir branch: `feature/user-auth` → `user-auth`)
3. **Detail task** — Project: `.workspace/.scratch/<slug>/tasks.md` (format: `## Queue`/`## In Progress`/`## Done`, ambil `Detail:`)
4. **Path dari user** — validasi file exists/readable. Invalid → kembali ke sumber sebelumnya

Universal mode tidak mengasumsikan requirements/tasks `.workspace`; gunakan inline spec, file yang user berikan, atau laporkan "no spec available".

Project mode: Global Requirements di `.workspace/context/SRS.md` (bila ada) ikut jadi acuan axis Spec — requirement global dilanggar/neglected oleh diff → laporkan di axis Spec.

Tidak ketemu → tanya user. User bilang tidak ada → sub-agent Spec skip, laporkan "no spec available".

## Step 3 — Find Standards Source

Gunakan Context Resolver. Cari file dokumentasi coding style (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, dll) jika tersedia.

**Smell baseline** (selalu bawa, Fowler _Refactoring_ ch.3):

- Speculative Generality → hapus, inline sampai kebutuhan nyata
- Message Chains (`a.b().c().d()`) → sembunyikan di balik 1 method
- Middle Man (delegasi saja) → potong, panggil target langsung
- Refused Bequest (abaikan warisan) → drop inheritance, pakai composition

Message Chains vs Middle Man adalah trade-off, bukan dua aturan mutlak: hide delegate kalau chain dipakai banyak caller; potong middle man kalau delegasinya tidak menambah behavior.

## Step 4 — Run in Parallel

Satu pesan, dua sub-agent (general-purpose), tanpa saling lihat konteks:

**Sub-agent Standards** dapat: full diff + commit list (kosong kalau `none`), standards file, smell baseline.
Brief: laporkan per file/hunk langgar standard terdokumentasi (kutip sumber+rule) + smell baseline terdeteksi. Bedakan hard violation vs judgement call. Skip yang sudah dihandle tooling. **<400 kata**.

**Sub-agent Spec** dapat: full diff + commit list, spec path/isi (termasuk `Done:`).
Brief: laporkan (a) requirement hilang/parsial, (b) behavior tidak diminta (scope creep), (c) requirement kelihatan diimplement tapi salah, (d) **Done criteria** terpenuhi/tidak. Kutip baris spec tiap temuan. **<400 kata**.

**Fallback Sequential**: Standards dulu → laporkan → Spec. Output tetap dipisah heading `## Standards` / `## Spec`, jangan merge.

### Sub-Agent Error Handling

Salah satu gagal → jangan block total. Laporkan partial: "Standards: [result], Spec: [error]". Tetap tampilkan heading keduanya — yang gagal isi pesan error.

## Step 5 — Aggregate

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

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Belum ada diff → kerjakan perubahan dulu. Hanya 1 axis → jalanin utuh (axis lain report "tidak ada data"). Butuh deepening arsitektur → `improve-architecture`.
