# Workspace File Templates

Sumber tunggal bentuk semua file yang dilahirkan `setup-workflow`. Nama section dikunci — skill lain membaca struktur ini. Aturan umum:

- Section bertanda `<!-- auto -->` boleh di-refresh; section tanpa marker = manual, `--refresh` tidak menyentuh
- Target PROJECT.md ≤ ~100 baris; lebih → pindahkan isi ke CONTEXT.md (Aturan Split)
- `--no-context`: section detail CONTEXT.md disisipkan ke PROJECT.md sebagai section tambahan tanpa marker

---

## PROJECT.md

Path: `.workspace/context/PROJECT.md`

```markdown
# PROJECT — <name>

Quick reference untuk agent — baca sebelum eksekusi skill di project ini.
Precedence: instruksi user saat ini > file ini > CONTEXT.md > asumsi.

## Commands <!-- auto -->

- <build/test/run — 1 baris per command>

## File Map <!-- auto -->

- <path> — <fungsi, 1 baris>

## Core Terms <!-- auto -->

- <istilah> — <definisi ≤1 baris>

## Conventions <!-- auto -->

- <pola/status yang sering dicek>

## Advanced Details

Glossary/pattern/gotcha → `CONTEXT.md` · Requirement global → `SRS.md` · Progres → `TRACKER.md` · Keputusan final → `ADR.md`
```

---

## CONTEXT.md

Path: `.workspace/context/CONTEXT.md`

```markdown
# CONTEXT — <name>

Detail domain project — lazy-load saat perlu. Quick ref ada di PROJECT.md.

## Glossary <!-- auto -->

- <istilah> — <penjelasan lengkap, contoh pemakaian, sinonim>

## Code Patterns & Conventions <!-- auto -->

- <pattern> — <kapan dipakai + contoh singkat>

## Gotcha <!-- auto -->

- <jebakan/perangkap> — <cara menghindarinya>

## Historical Decisions <!-- auto -->

- <ringkasan keputusan lama> — detail di `ADR-N`

## References

- <link eksternal / template / sample>
```

Aturan: 1 entri = 1 konsep. Definisi yang muat 1 baris naikkan ke PROJECT.md (Aturan Split).

---

## SRS.md

Path: `.workspace/context/SRS.md`

```markdown
# SRS — <name>

Requirement global project. Single-writer konten: `to-requirements`.

## Global Requirements

<!-- Requirement lintas fitur / NFR, format EARS -->

- WHEN token expired THEN sistem SHALL redirect ke login dengan pesan "sesi berakhir"

## Feature Index

<!-- <slug> | <judul> | status | path requirements — status: draft | approved | superseded -->

- user-auth | Login OAuth | approved | .scratch/user-auth/requirements.md
```

Status di Feature Index = lifecycle requirement, bukan progres eksekusi (progres ada di TRACKER.md).

---

## TRACKER.md

Path: `.workspace/context/TRACKER.md`

```yaml
# Feature execution progress. See `.workspace/context/SRS.md` for requirement status.
tracker: local
features:
  - slug: <feature-slug>
    status: open # open | done — semua task Done = done
    source: to-requirements | ask-me | manual
    created: <YYYY-MM-DD>
    updated: <YYYY-MM-DD>
    task_count: <total>
    task_done: <selesai>
```

Single-writer: `to-tasks` (buat entry), `implement` (counter). Task In Progress tidak diduplikat di sini — lihat `.scratch/<slug>/tasks.md`.

---

## ADR.md

Path: `.workspace/context/ADR.md`. Entry baru append di bawah; nomor sequential dan tidak pernah dipakai ulang. Entry lama tidak diubah kecuali menandai superseded.

```markdown
# ADR — <name>

Keputusan arsitektur final. Lolos ADR Filter (hard to reverse + surprising + real trade-off) baru dicatat.

## ADR-1: <decision title>

**Status**: accepted | superseded by ADR-N
**Konteks**: <masalah dan paksaannya, 1-3 kalimat>
**Keputusan**: <pilihan yang diambil>
**Konsekuensi**: <dampak positif/negatif yang sengaja diterima>
```

---

## ARCHITECTURE.md

Path: `.workspace/context/ARCHITECTURE.md`. Conditional — hanya untuk project >10 folder `features/`, multi-module/workspace, atau permintaan user eksplisit.

```markdown
# Architecture — <name>

## Overview

<2-4 kalimat: gaya arsitektur dan alasannya>

## Module Map <!-- auto -->

- <module/folder> — <tanggung jawab, 1 baris>

## Dependency Direction <!-- auto -->

- <A> → <B>: <kontrak/alasan arah dependency>
```
