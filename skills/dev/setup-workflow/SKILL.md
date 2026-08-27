---
name: setup-workflow
description: "Setup kumpulan skill dev untuk sebuah repo/project. Deteksi status project (baru/existing), generate .workspace/ sebagai tracker lokal: PROJECT.md (quick refs) + CONTEXT.md (full detail). Jalankan jika user membutuhkan context dan persistence lintas sesi; workflow universal tetap bisa dipakai tanpa setup."
disable-model-invocation: true
---

# Setup Workflow

Tulis config yang skill lain baca. Run sekali per repo. Deteksi state repo nyata, konfirmasi kalau ambigu, baru tulis.

## Flags

- `--refresh` — Re-scan codebase, update PROJECT.md + CONTEXT.md + ARCHITECTURE.md (kalau ada) secara merge-safe, bump `context_updated` di project-meta.md. No overwrite ADR.md/TRACKER.md/.scratch/.
- `--refresh --force` — `--refresh` + full overwrite PROJECT.md/CONTEXT.md (abaikan marker manual, semua section ditulis ulang dari scan)
- `--migrate-structure` — One-shot migrasi struktur lama ke baru (`context/`). Hanya jalan kalau struktur lama terdeteksi.
- `--no-context` — Setup tanpa CONTEXT.md (project kecil). Default: CONTEXT.md aktif.

## PROJECT.md vs CONTEXT.md Split Rules

PROJECT.md = **quick references only** — yang dibutuhkan tiap turn, target ≤ ~100 baris:

- Command cheatsheet, file map (1-baris/file), istilah inti (1-baris/istilah)
- Konvensi/status yang sering dicek
- Pointer ke detail: `Lihat CONTEXT.md → <section>`

CONTEXT.md = **full detail** — lazy-load saat perlu:

- Glossary panjang, penjelasan konsep, edge case, sinonim
- Pattern kode, gotcha, keputusan historis (ringkasan ADR)
- Template/sample, referensi eksternal

### Canonical Template

Semua file context lahir dari skeleton fixed di [docs/TEMPLATES.md](docs/TEMPLATES.md) — nama section tidak boleh diubah (skill lain bergantung padanya). Ringkasannya:

| File              | Isi inti                                      | Writer                    |
| ----------------- | --------------------------------------------- | ------------------------- |
| `PROJECT.md`      | quick ref + frontmatter style reference       | setup/ask-me/implement    |
| `CONTEXT.md`      | glossary, pattern, gotcha, keputusan historis | setup/ask-me              |
| `SRS.md`          | global requirement EARS + feature index       | `to-requirements` tunggal |
| `TRACKER.md`      | progres eksekusi fitur                        | `to-tasks` + `implement`  |
| `ADR.md`          | keputusan final berformat                     | alur ADR per skill        |
| `ARCHITECTURE.md` | module map + arah dependency (conditional)    | setup/refresh             |

Rule isi saat grill/scan:

- Definisi ≤ 1 baris → PROJECT.md
- Penjelasan > 1 baris, contoh, edge case → CONTEXT.md
- Requirement behavior (format EARS) lintas fitur/NFR → `.workspace/context/SRS.md` — bukan CONTEXT.md
- Section yang boleh di-refresh WAJIB marker `<!-- auto -->` di bawah heading
- Section tanpa marker = manual, `--refresh` tidak menyentuh

## Step 1 — Check Setup Marker

Cek exist: `.workspace/project-meta.md`

- **Ada** → setup sudah jalan. Baca, tampilkan ringkasan (status, setup_date, context_updated, has_context, has_architecture).
  - `--refresh` → Step 7
  - `--migrate-structure` → Step 6
  - Tanpa flag → beri tahu setup sudah tersedia, lalu arahkan ke `ask-me`.
- **Tidak ada** → cek dulu struktur lama: file `.workspace/CONTEXT.md`, `.workspace/ADR.md`, `.workspace/ARCHITECTURE.md`, `.workspace/issue-tracker.md` langsung di root `.workspace/`, `.workspace/tracking/issue-tracker.md` (struktur v2), ATAU `.workspace/context/AGENTS.md` (sisa penamaan v3). Terdeteksi + flag `--migrate-structure` → jalankan Step 6 bagian A dulu, baru lanjut setup normal dari Step 2. Selain itu → lanjut Step 2.

## Step 2 — Detect Project Status

Dari isi folder + git history:

- Kosong / hanya scaffold bawaan (flutter create, create-react-app, next-app default, no modifikasi) → `status: new`
- Banyak file custom (+ git history > initial commit) → `status: existing`
- Bukan git repo → deteksi dari isi folder. Kosong/hanya `.workspace/` → `new`

## Step 3 — Populate PROJECT.md, CONTEXT.md, ADR.md, ARCHITECTURE.md (conditional)

Buat folder `.workspace/context/` kalau belum ada.

### Existing Project

- Scan ringan: struktur folder, dependency utama, pattern arsitektur
- Isi `.workspace/context/PROJECT.md` (quick) + `.workspace/context/CONTEXT.md` (detail) dari scan otomatis, ikuti **Aturan Split**
- `--no-context` → hanya PROJECT.md (detail disisipkan sebagai section di PROJECT.md)
- `.workspace/context/ADR.md` → kosong, isi dari [template](docs/TEMPLATES.md#adrmd)
- `.workspace/context/SRS.md` → scaffold template saja (Step 4); konten diisi `to-requirements`
- **ARCHITECTURE.md conditional**: generate HANYA JIKA:
  - Scan deteksi >10 folder di `features/` ATAU multi-module/workspace ATAU user confirm "ya, buat ARCHITECTURE.md"
  - Skip: set `has_architecture: false` di project-meta.md, note di PROJECT.md: `architecture: standard feature-first (see PROJECT.md for conventions)`

### New Project

- Delegasikan ke `ask-me` — jalankan grill dalam **Mode Bangun Domain** (interview loop, PROJECT.md + CONTEXT.md kosong)
- `ask-me` isi `PROJECT.md` (quick) + `CONTEXT.md` (detail) + `ADR.md` langsung, ikuti **Aturan Split**
- `--no-context` → `ask-me` tulis semua ke PROJECT.md saja
- Tanya: "Generate ARCHITECTURE.md? [y/N]" — `ask-me` bantu isi dari [template](docs/TEMPLATES.md#architecturemd)
- Setup seed pertama `.workspace/context/SRS.md`: Global Requirements diisi dari keputusan global/NFR hasil interview (security, perf, compliance — format EARS). Update selanjutnya milik `to-requirements` (single-writer).
- **Prototype opt-in**: tanya "Desain UI/logic mau divalidasi dulu via `prototype` sebelum SRS difinalisasi? [y/N]". Ya → jalankan LOGIC/UI; keputusan tervalidasi dicatat sebagai baris Global Requirements / catatan desain. Tidak → langsung finalisasi.
- Setup tidak lanjut Step 4 sampai `ask-me` selesai

## Step 4 — Generate Tracking Files and Seeds

Tulis jika belum ada. Sudah ada & format valid → skip. Format rusak/kosong → tanya: `"<file> ada tapi formatnya rusak. Overwrite dengan default?"` — jangan overwrite diam-diam.

- Aturan canonical berada di `../shared/TDD.md` dan selalu dibaca oleh `implement`.
- `.workspace/context/SRS.md` — requirement global + index fitur, lahir dari [template](docs/TEMPLATES.md#srsmd). Konten diisi `to-requirements`; setup hanya menulis seed saat New Project.
- `.workspace/context/TRACKER.md` — index EKSEKUSI per fitur, lahir dari [template](docs/TEMPLATES.md#trackermd). Status requirement ada di `.workspace/context/SRS.md` Feature Index — jangan diduplikat di sini. Single-writer: `to-tasks` (buat entry), `implement` (counter):
  ```yaml
  # Progres eksekusi fitur. Status requirement = lihat `.workspace/context/SRS.md`.
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
  Kosong (`features: []`) saat pertama dibuat — diisi `to-tasks` saat fitur pertama di-breakdown.

Struktur task lokal (lazy-created saat `to-requirements`/`to-tasks` dipanggil pertama kali):

- `.workspace/.scratch/<feature-slug>/requirements.md` (dari `to-requirements`)
- `.workspace/.scratch/<feature-slug>/tasks.md` (dari `to-tasks`, single-file checklist: `## Queue`/`## In Progress`/`## Done`/`## Superseded`)

## Step 5 — Write project-meta.md

Path: `.workspace/project-meta.md`

```
---
status: <new|existing>
setup_date: <YYYY-MM-DD>
context_updated: <YYYY-MM-DD>
has_context: <true|false>
has_architecture: <true|false>
migrated_at: <YYYY-MM-DD>  # hanya kalau --migrate-structure jalan
```

## Step 6 — Migration (only `--migrate-structure`)

HANYA kalau flag `--migrate-structure`. Trigger: struktur lama terdeteksi (file `.workspace/CONTEXT.md`, `.workspace/ADR.md`, `.workspace/ARCHITECTURE.md`, `.workspace/issue-tracker.md` di root, `.workspace/tracking/issue-tracker.md` sisa v2, ATAU `.workspace/context/AGENTS.md` sisa penamaan v3) ATAU `has_context: false` (PROJECT.md campur quick+detail, belum ada CONTEXT.md). Aturan TDD canonical berada di `../shared/TDD.md`.

A. Struktur lama terdeteksi → konsolidasi ke `context/`:

1. Buat folder `.workspace/context/`
2. Move:
   - `.workspace/CONTEXT.md` → `.workspace/context/PROJECT.md`
   - `.workspace/ADR.md` → `.workspace/context/ADR.md`
   - `.workspace/ARCHITECTURE.md` (kalau ada) → `.workspace/context/ARCHITECTURE.md`
   - `.workspace/issue-tracker.md` → `.workspace/context/TRACKER.md`
   - `.workspace/tracking/issue-tracker.md` (sisa v2) → `.workspace/context/TRACKER.md`; folder `.workspace/tracking/` kosong setelahnya boleh dihapus
   - `.workspace/context/AGENTS.md` (sisa v3) → `.workspace/context/PROJECT.md` — rename saja, isi tidak berubah
   - File TDD lama: jangan dimigrasikan; gunakan `../shared/TDD.md` sebagai satu-satunya aturan TDD.
3. Update `project-meta.md`: `migrated_at: <today>`, `has_architecture` berdasarkan keberadaan ARCHITECTURE.md
4. (Optional) Symlink compat: `.workspace/CONTEXT.md` → `context/PROJECT.md`

B. `has_context: false` → split PROJECT.md campur quick+detail. `--no-context` → skip B, biarkan `has_context: false`:

1. Split `.workspace/context/PROJECT.md`: section quick (commands, file map, istilah 1-baris) → tetap di PROJECT.md
2. Sisanya (glossary panjang, pattern, gotcha) → `.workspace/context/CONTEXT.md` baru
3. Tampilkan hasil split ke user untuk konfirmasi/koreksi sebelum tulis
4. Set `has_context: true`, `migrated_at: <today>`

Print: "Migration complete. Structure updated (PROJECT.md + CONTEXT.md)."

## Step 7 — Refresh (only `--refresh`)

HANYA kalau flag `--refresh`:

1. Re-scan codebase (existing) / re-grill ringkas via `ask-me` (new) → update `PROJECT.md` + `CONTEXT.md` (ikuti **Aturan Split**)
2. **Merge-safe**: section bertanda `<!-- auto -->` di-update/append dari scan baru; section manual (no marker) → SKIP, jangan sentuh
3. `--force` → full overwrite kedua file (section manual ikut tertulis ulang)
4. Kalau `has_architecture: true` → re-generate `ARCHITECTURE.md` dari scan terbaru
5. Scaffold yang hilang dibuat ulang dari template (termasuk `.workspace/context/SRS.md` kalau belum ada — konten tidak disentuh)
6. Update `project-meta.md`: `context_updated: <today>`
7. Print: "Context refreshed. Laporkan file yang benar-benar diperbarui: PROJECT.md; CONTEXT.md jika `has_context: true`; ARCHITECTURE.md jika `has_architecture: true`."

## Step 8 — Complete

Beri tahu user:

- Setup complete / Refreshed / Migrated
- Status terdeteksi (new/existing)
- CONTEXT.md generated: yes/no (`--no-context`)
- SRS.md generated: yes/no
- ARCHITECTURE.md generated: yes/no
- Arahkan ke `ask-me` untuk mulai kerja

## Rerun

Setup hanya perlu diulang kalau user eksplisit minta reset. Skill ini tidak auto re-run selama `project-meta.md` masih ada.
Gunakan `--refresh` untuk update konteks, `--migrate-structure` untuk upgrade struktur lama ke PROJECT.md+CONTEXT.md.
