---
name: setup-workflow
description: "Setup kumpulan skill dev untuk sebuah repo/project. Deteksi status project (baru/existing), generate .workspace/ sebagai context dan tracker lokal: PROJECT.md, CONTEXT.md, SRS.md, TRACKER.md, dan work card fitur. Jalankan jika user membutuhkan context dan persistence lintas sesi; workflow universal tetap bisa dipakai tanpa setup."
disable-model-invocation: true
---

# Setup Workflow

Tulis config yang skill lain baca. Run sekali per repo. Deteksi state repo nyata, konfirmasi kalau ambigu, baru tulis.

## Flags

- `--refresh` — Re-scan codebase, update PROJECT.md + CONTEXT.md + ARCHITECTURE.md (kalau ada) secara merge-safe, bump `context_updated` di project-meta.md. No overwrite ADR.md/TRACKER.md/SRS.md/work/.
- `--refresh --force` — `--refresh` + full overwrite PROJECT.md/CONTEXT.md (abaikan marker manual, semua section ditulis ulang dari scan)
- `--migrate-structure` — One-shot migrasi struktur lama ke `context/` + work card `work/F-<id>.md`. Hanya jalan kalau struktur lama atau artifact `.scratch/<slug>/` terdeteksi.
- `--no-context` — Setup tanpa CONTEXT.md (project kecil). Default: CONTEXT.md aktif.

## PROJECT.md vs CONTEXT.md Split Rules

PROJECT.md = **quick references only** — yang dibutuhkan tiap turn, target ≤ ~100 baris:
- Command cheatsheet, file map (1-baris/file), istilah inti (1-baris/istilah)
- Konvensi/status yang sering dicek
- Pointer ke detail: `Lihat CONTEXT.md → <section>`

CONTEXT.md = **pengetahuan domain dan teknis** — lazy-load saat perlu:
- Domain model, relasi konsep, dan istilah yang tidak cukup dijelaskan satu baris
- Runtime, integrasi, batasan, dan source fakta
- Pattern kode yang sudah terbukti, peta test, gotcha, dan ringkasan keputusan historis

### Canonical Template

Semua file context lahir dari skeleton fixed di [docs/TEMPLATES.md](docs/TEMPLATES.md) — nama section tidak boleh diubah (skill lain bergantung padanya). Ringkasannya:

| File | Isi inti | Writer |
|------|----------|--------|
| `PROJECT.md` | quick ref + frontmatter style reference | setup/ask-me/implement |
| `CONTEXT.md` | glossary, pattern, gotcha, keputusan historis | setup/ask-me |
| `SRS.md` | baseline requirement global + Feature Registry + requirement fitur approved | `to-requirements` tunggal |
| `work/F-<id>.md` | work card sementara: requirement detail + task aktif | `to-requirements` + `to-tasks` + `implement` |
| `TRACKER.md` | progres eksekusi fitur | `to-tasks` + `implement` |
| `ADR.md` | keputusan final berformat | alur ADR per skill |
| `ARCHITECTURE.md` | module map + arah dependency (conditional) | setup/refresh |

Rule isi saat grill/scan:
- Definisi ≤ 1 baris → PROJECT.md
- Penjelasan > 1 baris, contoh, edge case → CONTEXT.md
- Requirement behavior (format EARS) lintas fitur/NFR → `.workspace/context/SRS.md` — bukan CONTEXT.md
- Requirement fitur yang sudah approved → `.workspace/context/SRS.md` Feature Requirements
- Detail requirement dan task yang masih dikerjakan → `.workspace/work/F-<id>.md`
- Section yang boleh di-refresh WAJIB marker `<!-- auto -->` di bawah heading
- Section tanpa marker = manual, `--refresh` tidak menyentuh

## Step 1 — Check Setup Marker

Cek exist: `.workspace/project-meta.md`

- **Ada** → setup sudah jalan. Baca, tampilkan ringkasan (status, setup_date, context_updated, has_context, has_architecture, dan apakah Feature Registry/work card tersedia).
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
- Isi `.workspace/context/PROJECT.md` (quick) + `.workspace/context/CONTEXT.md` (domain/teknis) dari scan otomatis, ikuti **Aturan Split** dan struktur `Domain Model`, `Runtime and Integrations`, `Code Patterns`, `Testing Map`, dan `Gotchas` pada template. Setiap fakta penting sertakan `Source`.
- `--no-context` → hanya PROJECT.md (detail disisipkan sebagai section di PROJECT.md)
- `.workspace/context/ADR.md` → kosong, isi dari [template](docs/TEMPLATES.md#adrmd)
- `.workspace/context/SRS.md` → scaffold template kosong (Step 4); baseline diisi `to-requirements` setelah requirement disepakati
- **ARCHITECTURE.md conditional**: generate HANYA JIKA:
  - Scan deteksi >10 folder di `features/` ATAU multi-module/workspace ATAU user confirm "ya, buat ARCHITECTURE.md"
  - Skip: set `has_architecture: false` di project-meta.md, note di PROJECT.md: `architecture: standard feature-first (see PROJECT.md for conventions)`

### New Project
- Delegasikan ke `ask-me` — jalankan grill dalam **Mode Bangun Domain** (interview loop, PROJECT.md + CONTEXT.md kosong)
- `ask-me` isi `PROJECT.md` (quick) + `CONTEXT.md` (domain/teknis) + `ADR.md` langsung, ikuti **Aturan Split** dan letakkan fakta domain/integrasi/pattern/test/gotcha pada section CONTEXT yang sesuai.
- `--no-context` → `ask-me` tulis semua ke PROJECT.md saja
- Tanya: "Generate ARCHITECTURE.md? [y/N]" — `ask-me` bantu isi dari [template](docs/TEMPLATES.md#architecturemd)
- Setup seed pertama `.workspace/context/SRS.md`: hanya isi Global Requirements jika ada keputusan global/NFR hasil interview (format EARS); Feature Registry dan Feature Requirements tetap kosong. Update selanjutnya milik `to-requirements` (single-writer).
- **Prototype opt-in**: tanya "Desain UI/logic mau divalidasi dulu via `prototype` sebelum SRS difinalisasi? [y/N]". Ya → jalankan LOGIC/UI; decision capture disimpan pada work card `F-<id>`, dan hanya requirement lintas fitur yang dipromosikan ke Global Requirements SRS melalui `to-requirements`. Tidak → langsung finalisasi.
- Setup tidak lanjut Step 4 sampai `ask-me` selesai



## Step 4 — Generate Tracking Files and Seeds

Tulis jika belum ada. Sudah ada & format valid → skip. Format rusak/kosong → tanya: `"<file> ada tapi formatnya rusak. Overwrite dengan default?"` — jangan overwrite diam-diam.

- Aturan canonical berada di `../shared/TDD.md` dan selalu dibaca oleh `implement`.
- `.workspace/context/SRS.md` — baseline requirement global + Feature Registry + Feature Requirements, lahir dari [template](docs/TEMPLATES.md#srsmd). Single-writer konten requirement: `to-requirements`.
- `.workspace/work/F-<id>.md` — work card sementara berisi requirement detail dan task aktif, lahir dari [template](docs/TEMPLATES.md#work-card). ID fitur dialokasikan dari Feature Registry dan tidak boleh dipakai ulang.
- `.workspace/context/TRACKER.md` — index progres eksekusi per fitur, lahir dari [template](docs/TEMPLATES.md#trackermd). Status requirement ada di SRS; jangan diduplikat di tracker. Single-writer: `to-tasks` (buat entry), `implement` (counter):
  ```yaml
  # Progres eksekusi fitur. Lifecycle requirement = lihat `.workspace/context/SRS.md`.
  tracker: local
  features:
    - id: F-<id>
      status: open          # open | done — semua task Done = done
      source: to-requirements | ask-me | manual
      created: <YYYY-MM-DD>
      updated: <YYYY-MM-DD>
      task_count: <total>
      task_done: <selesai>
  ```
  Kosong (`features: []`) saat pertama dibuat — diisi `to-tasks` saat fitur pertama di-breakdown.

Work card dibuat lazy saat `to-requirements` dipanggil dalam Project mode. Setelah requirement approved tersalin ke SRS dan seluruh task selesai, work card boleh dihapus setelah konfirmasi user.

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

HANYA kalau flag `--migrate-structure`. Trigger: struktur lama terdeteksi (file `.workspace/CONTEXT.md`, `.workspace/ADR.md`, `.workspace/ARCHITECTURE.md`, `.workspace/issue-tracker.md` di root, `.workspace/tracking/issue-tracker.md` sisa v2, `.workspace/context/AGENTS.md` sisa penamaan v3, ATAU artifact fitur `.workspace/.scratch/<slug>/requirements.md`/`tasks.md`) ATAU `has_context: false` (PROJECT.md campur quick+detail, belum ada CONTEXT.md). Aturan TDD canonical berada di `../shared/TDD.md`.

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

C. Artifact fitur legacy `.workspace/.scratch/<slug>/` terdeteksi → migrasikan secara eksplisit:
1. Baca requirements dan tasks yang ada; jangan menghapus source legacy pada tahap ini.
2. Cocokkan dengan Feature Registry yang sudah ada. Jika belum ada ID, alokasikan ID fitur berikutnya yang belum pernah dipakai; jangan gunakan ulang ID lama.
3. Gabungkan requirement detail dan task ke `.workspace/work/F-<id>.md`; pertahankan AC, `Ref`, status requirement, dan evidence yang tersedia.
4. Tampilkan mapping `<slug> → F-<id>` serta preview file sebelum menulis.
5. Setelah validasi dan konfirmasi user, hapus artifact legacy yang sudah berhasil dimigrasikan.

Print: "Migration complete. Structure updated (PROJECT.md + CONTEXT.md + work cards)."

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

## Output Contract

Tutup workflow dengan:

```text
Changes: <context, SRS, tracker, atau work card yang dibuat/diubah>
Validation: <status project, format context/SRS, dan hasil migrasi bila ada>
Status: <complete | partial | blocked | cancelled>
Risks/Limitations: <none atau daftar singkat>
Next Step: <ask-me, to-requirements, atau aksi lain; tanpa auto-apply>
```

## Rerun

Setup hanya perlu diulang kalau user eksplisit minta reset. Skill ini tidak auto re-run selama `project-meta.md` masih ada.
Gunakan `--refresh` untuk update konteks, `--migrate-structure` untuk upgrade struktur lama ke PROJECT.md+CONTEXT.md dan migrasi artifact fitur ke work card.
