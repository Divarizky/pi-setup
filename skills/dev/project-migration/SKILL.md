---
name: project-migration
description: "Migrasi dari project lama ke project baru. Tentukan strategi (migration-approach, cutover-strategy) dulu, lalu context intake, risk register, migration plan per slice, safety net, migrate, validate. User-invoked."
disable-model-invocation: true
---

# Project Migration

Migrasi project lama ke project baru dengan risiko terkendali. Bukan deepening in-place → `improve-architecture`.

## Vocabulary

[VOCABULARY](../shared/VOCABULARY.md#arsitektur) — module, interface, depth, seam, adapter, locality.

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — warning "tanpa setup, context terbatas".

## Step 1 — Lokasi Project Lama

Tanya: **file path lokal atau repository (GitHub/GitLab/URL)?**

- **Lokal**: tanya absolute path, agent scan langsung
- **Repository**: tanya URL + branch/tag (default: utama). Clone ke `_migration-source/` di working directory project baru. Path scan = folder hasil clone
- **Tidak bisa akses langsung**: user export/describe manual

Simpan ke `.workspace/.scratch/migration/meta.md`:
```
migration_source: <absolute path / clone path / "manual">
migration_source_type: <local|repository|manual>
```

## Step 2 — Tentukan Strategi

Baca `docs/MIGRATION-APPROACH.md` → tanya 2 pertanyaan (platform sama/beda, tujuan) → **Opsi A: Bangun Ulang (rewrite)** atau **B: Pindahkan + Sesuaikan (port)**.

Baca `docs/CUTOVER-STRATEGY.md` → tanya 2 pertanyaan (boleh downtime, toleransi durasi) → **Opsi A: Bertahap (phased)** atau **B: Sekali Jalan (bigbang)**.

Catat di `meta.md`:
```
migration_approach: <rewrite|port>
cutover_strategy: <phased|bigbang>
```

## Step 3 — Context Intake

Lihat `docs/CONTEXT-SCAN.md`. Scan struktur folder, dependency, pattern arsitektur project **lama** (pakai `migration_source` path). Baca `AGENT.md` (quick) + `CONTEXT.md` (detail) + `ADR.md` project baru — jangan re-litigasi keputusan final tanpa alasan kuat.

## Step 4 — Risk Register

Lihat `docs/RISK-REGISTER-TEMPLATE.md`. Identifikasi area rawan break, modul kandidat migrasi, seam yang tidak ada.

Klasifikasi dependency tiap kandidat (sama table di `improve-architecture`).

## Step 5 — Migration Plan (Vertical Slice)

Pecah per modul, bukan big-bang kode (kecuali `cutover_strategy: bigbang` — soal rilis akhir, bukan cara tulis kode).

- `rewrite` → tiap slice ikuti `implement` (spec ulang, TDD dari nol)
- `port` → tiap slice ikuti `bug-diagnosis` mindset (characterization test dulu, jaga behavior identik)
- `phased` → urutkan slice per fitur, definisikan cara 2 sistem jalan bersamaan (routing, data sync)
- `bigbang` → urutkan slice bebas berdasarkan risk register, no koordinasi 2 sistem

## Step 6 — Test Safety Net

Sebelum ubah kode: belum ada test di area disentuh → tulis characterization test dulu (capture behavior existing termasuk bug belum waktunya diperbaiki).

## Step 7 — Migrate

Eksekusi slice sesuai Step 5. Update `AGENT.md` inline kalau modul dinamai konsep baru.

## Step 8 — Validate

Regression test penuh tiap slice — pastikan slice lain tidak ikut pecah.

Semua slice lolos → hapus state migrasi transient: folder `.workspace/.scratch/migration/` dan clone `_migration-source/`. Project baru berdiri sendiri.

## ADR — Kapan Catat

Tawarkan ADR kalau user tolak pendekatan migrasi dengan alasan load-bearing. Skip untuk alasan sementara.

## Saran Skills Lain

[Cross-ref](../shared/COMMON.md#saran-skills-lain) — Deepening/refactor tanpa pindah project → `improve-architecture`. Perubahan kecil, tidak sentuh struktur modul → `ask-me` grill → `implement`. Bug fix project existing → `bug-diagnosis`.