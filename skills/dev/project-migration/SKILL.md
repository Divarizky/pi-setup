---
name: project-migration
description: "Migrasi dari project lama ke project baru. Tentukan strategi (migration-approach, cutover-strategy) dulu, lalu context intake, risk register, migration plan per slice, safety net, migrate, validate. User-invoked."
disable-model-invocation: true
---

# Project Migration

Migrasi project lama ke project baru dengan risiko terkendali. Bukan deepening in-place → `improve-architecture`.

## Vocabulary

[Vocabulary](../shared/VOCABULARY.md#architecture) — module, interface, depth, seam, adapter, locality.

## Prerequisites

**Wajib Project mode.** `.workspace/project-meta.md` harus tersedia sebelum migrasi dimulai.

Jika belum ada → arahkan ke `setup-workflow`, tunda migrasi, dan jangan mulai scan atau membuat state migrasi.

## Step 1 — Locate Legacy Project

Tanya: **file path lokal atau repository (GitHub/GitLab/URL)?**

- **Lokal**: tanya absolute path, agent scan langsung
- **Repository**: tanya URL + branch/tag (default: utama). Tambahkan `migration-source/` ke `.gitignore` project baru dulu — clone jangan ikut ter-commit. Clone ke `migration-source/` di working directory project baru. Path scan = folder hasil clone
- **Tidak bisa akses langsung**: user export/describe manual

Simpan metadata migrasi ke `.workspace/.scratch/migration/meta.md`. Karena skill ini wajib Project, jangan jalankan migration workflow dalam Universal mode.

```
migration_source: <absolute path / clone path / "manual">
migration_source_type: <local|repository|manual>
```

## Step 2 — Choose Strategy

Baca `docs/MIGRATION-APPROACH.md` → tanya 2 pertanyaan (platform sama/beda, tujuan) → **Opsi A: Bangun Ulang (rewrite)** atau **B: Pindahkan + Sesuaikan (port)**.

Baca `docs/CUTOVER-STRATEGY.md` → tanya 2 pertanyaan (boleh downtime, toleransi durasi) → **Opsi A: Bertahap (phased)** atau **B: Sekali Jalan (bigbang)**.

Catat keputusan ke `meta.md`.

**Prototype opt-in**: migrasi yang menyentuh ulang UI/interface dan arahan desain belum jelas → tawarkan `prototype` (UI/LOGIC) sebelum eksekusi slice. Hasil capture jadi acuan behavior slice terkait.

## Step 3 — Context Intake

Lihat `docs/CONTEXT-SCAN.md`. Scan struktur folder, dependency, pattern arsitektur project **lama** (pakai `migration_source` path). Baca `.workspace/context/PROJECT.md` (quick) + `.workspace/context/CONTEXT.md` (detail) + `.workspace/context/ADR.md` project baru — jangan re-litigasi keputusan final tanpa alasan kuat.

## Step 4 — Risk Register

Lihat `docs/RISK-REGISTER-TEMPLATE.md`. Identifikasi area rawan break, modul kandidat migrasi, seam yang tidak ada.

Klasifikasi dependency tiap kandidat (sama table di `improve-architecture`).

## Step 5 — Migration Plan (Vertical Slice)

Pecah per modul, bukan big-bang kode (kecuali `cutover_strategy: bigbang` — soal rilis akhir, bukan cara tulis kode).

- `rewrite` → tiap slice ikuti `implement` (spec ulang, baca `../shared/TDD.md`)
- `port` → tiap slice ikuti `bug-diagnosis` mindset (characterization test dulu, gunakan boundary/RED rules dari `../shared/TDD.md`, jaga behavior identik)
- `phased` → urutkan slice per fitur, definisikan cara 2 sistem jalan bersamaan (routing, data sync)
- `bigbang` → urutkan slice bebas berdasarkan risk register, no koordinasi 2 sistem

## Step 6 — Test Safety Net

Sebelum ubah kode: belum ada test di area disentuh → tulis characterization test dulu (capture behavior existing termasuk bug belum waktunya diperbaiki). Untuk boundary, expected value, dan validasi RED, ikuti `../shared/TDD.md`.

## Step 7 — Migrate

Eksekusi slice sesuai Step 5. Update `.workspace/context/PROJECT.md` inline kalau modul dinamai konsep baru.

## Step 8 — Validate

Regression test penuh tiap slice — pastikan slice lain tidak ikut pecah.

Semua slice lolos → setelah konfirmasi user, hapus state migrasi transient di `.workspace/.scratch/migration/` dan clone `migration-source/`.

## ADR — When to Record

Tawarkan ADR kalau user tolak pendekatan migrasi dengan alasan load-bearing. Skip untuk alasan sementara.

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Deepening/refactor tanpa pindah project → `improve-architecture`. Perubahan kecil, tidak sentuh struktur modul → `ask-me` grill → `implement`. Bug fix project existing → `bug-diagnosis`.
