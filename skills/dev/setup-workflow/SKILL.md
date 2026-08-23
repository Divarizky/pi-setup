---
name: setup-workflow
description: "Setup kumpulan skill dev untuk sebuah repo/project. Deteksi status project (baru/existing), generate .workspace/ sebagai tracker lokal: AGENT.md (quick refs) + CONTEXT.md (full detail). Jalankan jika user membutuhkan context dan persistence lintas sesi; workflow universal tetap bisa dipakai tanpa setup."
disable-model-invocation: true
---

# Setup Workflow

Tulis config yang skill lain baca. Run sekali per repo. Deteksi state repo nyata, konfirmasi kalau ambigu, baru tulis.

## Flags

- `--refresh` — Re-scan codebase, update AGENT.md + CONTEXT.md + ARCHITECTURE.md (kalau ada) secara merge-safe, bump `context_updated` di project-meta.md. No overwrite ADR.md/issue-tracker.md/.scratch/.
- `--refresh --force` — `--refresh` + full overwrite AGENT.md/CONTEXT.md (abaikan marker manual, semua section ditulis ulang dari scan)
- `--migrate-structure` — One-shot migrasi struktur lama (flat di `.workspace/`) ke baru (`context/`, `tracking/`). Hanya jalan kalau struktur lama terdeteksi.
- `--no-context` — Setup tanpa CONTEXT.md (project kecil). Default: CONTEXT.md aktif.

## Aturan Split AGENT.md vs CONTEXT.md

AGENT.md = **quick references only** — yang dibutuhkan tiap turn, target ≤ ~100 baris:
- Command cheatsheet, file map (1-baris/file), istilah inti (1-baris/istilah)
- Konvensi/status yang sering dicek
- Pointer ke detail: `Lihat CONTEXT.md → <section>`

CONTEXT.md = **full detail** — lazy-load saat perlu:
- Glossary panjang, penjelasan konsep, edge case, sinonim
- Pattern kode, gotcha, keputusan historis (ringkasan ADR)
- Template/sample, referensi eksternal

Rule isi saat grill/scan:
- Definisi ≤ 1 baris → AGENT.md
- Penjelasan > 1 baris, contoh, edge case → CONTEXT.md
- Section yang boleh di-refresh WAJIB marker `<!-- auto -->` di bawah heading
- Section tanpa marker = manual, `--refresh` tidak menyentuh

## Step 1 — Cek Marker Setup

Cek exist: `.workspace/project-meta.md`

- **Ada** → setup sudah jalan. Baca, tampilkan ringkasan (status, setup_date, context_updated, has_context, has_architecture).
  - `--refresh` → Step 7
  - `--migrate-structure` → Step 6
  - Tanpa flag → beri tahu setup sudah tersedia, lalu arahkan ke `ask-me`.
- **Tidak ada** → lanjut Step 2.

## Step 2 — Deteksi Status Project

Dari isi folder + git history:

- Kosong / hanya scaffold bawaan (flutter create, create-react-app, next-app default, no modifikasi) → `status: new`
- Banyak file custom (+ git history > initial commit) → `status: existing`
- Bukan git repo → deteksi dari isi folder. Kosong/hanya `.workspace/` → `new`

## Step 3 — Isi AGENT.md, CONTEXT.md, ADR.md, ARCHITECTURE.md (conditional)

Buat folder `.workspace/context/`, `.workspace/tracking/` kalau belum ada.

### Existing Project
- Scan ringan: struktur folder, dependency utama, pattern arsitektur
- Isi `.workspace/context/AGENT.md` (quick) + `.workspace/context/CONTEXT.md` (detail) dari scan otomatis, ikuti **Aturan Split**
- `--no-context` → hanya AGENT.md (detail disisipkan sebagai section di AGENT.md)
- `.workspace/context/ADR.md` → kosong (template header saja)
- **ARCHITECTURE.md conditional**: generate HANYA JIKA:
  - Scan deteksi >10 folder di `features/` ATAU multi-module/workspace ATAU user confirm "ya, buat ARCHITECTURE.md"
  - Skip: set `has_architecture: false` di project-meta.md, note di AGENT.md: `architecture: standard feature-first (see AGENT.md for conventions)`

### New Project
- Delegasikan ke `ask-me` — jalankan grill dalam **Mode Bangun Domain** (interview loop, AGENT.md + CONTEXT.md kosong)
- `ask-me` isi `AGENT.md` (quick) + `CONTEXT.md` (detail) + `ADR.md` langsung, ikuti **Aturan Split**
- `--no-context` → `ask-me` tulis semua ke AGENT.md saja
- Tanya: "Generate ARCHITECTURE.md? [y/N]" — `ask-me` bantu isi template dasar
- Setup tidak lanjut Step 4 sampai `ask-me` selesai



## Step 4 — Generate File Tracking & Seeds

Tulis jika belum ada. Sudah ada & format valid → skip. Format rusak/kosong → tanya: `"<file> ada tapi formatnya rusak. Overwrite dengan default?"` — jangan overwrite diam-diam.

- Aturan canonical berada di `../shared/TDD.md` dan selalu dibaca oleh `implement`.
- `.workspace/tracking/issue-tracker.md` — index per fitur, schema:
  ```yaml
  tracker: local
  features:
    - slug: <feature-slug>
      status: open
      source: to-prd | ask-me | manual
      created: <YYYY-MM-DD>
      updated: <YYYY-MM-DD>
      task_count: <total>
      task_done: <selesai>
  ```
  Kosong (`features: []`) saat pertama dibuat — diisi `to-issues` saat fitur pertama di-breakdown.

Struktur task lokal (lazy-created saat `to-prd`/`to-issues` dipanggil pertama kali):
- `.workspace/.scratch/<feature-slug>/PRD.md` (dari `to-prd`)
- `.workspace/.scratch/<feature-slug>/tasks.md` (dari `to-issues`, single-file checklist: `## Queue`/`## In Progress`/`## Done`/`## Superseded`)

## Step 5 — Tulis project-meta.md

```
.workspace/project-meta.md
---
status: <new|existing>
setup_date: <YYYY-MM-DD>
context_updated: <YYYY-MM-DD>
has_context: <true|false>
has_architecture: <true|false>
migrated_at: <YYYY-MM-DD>  # hanya kalau --migrate-structure jalan
```

## Step 6 — Migration (--migrate-structure only)

HANYA kalau flag `--migrate-structure`. Trigger: struktur lama terdeteksi (file `.workspace/CONTEXT.md`, `.workspace/ADR.md`, `.workspace/ARCHITECTURE.md`, `.workspace/issue-tracker.md` di root) ATAU `has_context: false` (AGENT.md campur quick+detail, belum ada CONTEXT.md). Aturan TDD canonical berada di `../shared/TDD.md`.

A. Struktur lama terdeteksi → v1→v2:
1. Buat folder `.workspace/context/`, `.workspace/tracking/`
2. Move:
   - `.workspace/CONTEXT.md` → `.workspace/context/AGENT.md`
   - `.workspace/ADR.md` → `.workspace/context/ADR.md`
   - `.workspace/ARCHITECTURE.md` (kalau ada) → `.workspace/context/ARCHITECTURE.md`
   - `.workspace/issue-tracker.md` → `.workspace/tracking/issue-tracker.md`
   - File TDD lama: jangan dimigrasikan; gunakan `../shared/TDD.md` sebagai satu-satunya aturan TDD.
3. Update `project-meta.md`: `migrated_at: <today>`, `has_architecture` berdasarkan keberadaan ARCHITECTURE.md
4. (Optional) Symlink compat: `.workspace/CONTEXT.md` → `context/AGENT.md`

B. `has_context: false` → split AGENT.md campur quick+detail. `--no-context` → skip B, biarkan `has_context: false`:
1. Split `.workspace/context/AGENT.md`: section quick (commands, file map, istilah 1-baris) → tetap di AGENT.md
2. Sisanya (glossary panjang, pattern, gotcha) → `.workspace/context/CONTEXT.md` baru
3. Tampilkan hasil split ke user untuk konfirmasi/koreksi sebelum tulis
4. Set `has_context: true`, `migrated_at: <today>`

Print: "Migration complete. Structure updated (AGENT.md + CONTEXT.md)."

## Step 7 — Refresh (--refresh only)

HANYA kalau flag `--refresh`:

1. Re-scan codebase (existing) / re-grill ringkas via `ask-me` (new) → update `AGENT.md` + `CONTEXT.md` (ikuti **Aturan Split**)
2. **Merge-safe**: section bertanda `<!-- auto -->` di-update/append dari scan baru; section manual (no marker) → SKIP, jangan sentuh
3. `--force` → full overwrite kedua file (section manual ikut tertulis ulang)
4. Kalau `has_architecture: true` → re-generate `ARCHITECTURE.md` dari scan terbaru
5. Update `project-meta.md`: `context_updated: <today>`
6. Print: "Context refreshed. AGENT.md + CONTEXT.md + ARCHITECTURE.md updated."

## Step 8 — Selesai

Beri tahu user:
- Setup complete / Refreshed / Migrated
- Status terdeteksi (new/existing)
- CONTEXT.md generated: yes/no (`--no-context`)
- ARCHITECTURE.md generated: yes/no
- Arahkan ke `ask-me` untuk mulai kerja

## Re-run

Setup hanya perlu diulang kalau user eksplisit minta reset. Skill ini tidak auto re-run selama `project-meta.md` masih ada.
Gunakan `--refresh` untuk update konteks, `--migrate-structure` untuk upgrade struktur lama ke AGENT.md+CONTEXT.md.
