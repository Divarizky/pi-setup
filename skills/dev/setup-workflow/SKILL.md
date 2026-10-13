---
name: setup-workflow
description: "Setup kumpulan skill dev untuk sebuah repo/project. Deteksi status project (baru/existing), generate profile AGENTS.md (root), CONTEXT.md gabungan (.workspace/context/), CLAUDE.md pointer, SRS.md, TRACKER.md, dan work card fitur. Jalankan jika user membutuhkan context dan persistence lintas sesi; workflow universal tetap bisa dipakai tanpa setup."
disable-model-invocation: true
---

# Setup Workflow

Tulis config yang skill lain baca. Run sekali per repo. Deteksi state repo nyata, konfirmasi kalau ambigu, baru tulis.

## Flags

- `--refresh` — Re-scan codebase, update managed block AGENTS.md + CONTEXT.md + ARCHITECTURE.md + conditional stack docs (SECURITY.md, CODE_STYLE.md, DATABASE.md, API.md bila aktif) secara merge-safe, bump `context_updated` di project-meta.md. No overwrite ADR.md/TRACKER.md/SRS.md/work/.
- `--refresh --force` — `--refresh` + full overwrite managed block AGENTS.md/CONTEXT.md serta stack docs yang aktif (abaikan marker manual, semua section ditulis ulang dari scan)
- `--migrate-structure` — One-shot migrasi struktur lama ke AGENTS.md (root) + CONTEXT.md (.workspace/context/) + work card `work/F-<id>.md`. Hanya jalan kalau struktur lama (PROJECT.md, legacy context, dsb.) atau artifact `.scratch/<slug>/` terdeteksi.
- `--no-context` — Setup tanpa CONTEXT.md dan stack docs detail (project kecil). Hanya menghasilkan AGENTS.md dan CLAUDE.md pointer. Default: CONTEXT.md aktif.

## AGENTS.md vs CONTEXT.md Split Rules

AGENTS.md = **profil project & quick references** di root project — otomatis dibaca oleh Pi dan Codex setiap turn, target managed block ≤ ~100 baris:
- Identitas, command cheatsheet, istilah inti (1-baris/istilah)
- Konvensi/status yang sering dicek
- Pointer ke detail: `.workspace/context/CONTEXT.md → <section>`

CONTEXT.md = **pengetahuan domain dan teknis lengkap** di `.workspace/context/` — lazy-load saat perlu:
- File map lengkap (fungsi dan peran file/folder dalam codebase)
- Domain model, relasi konsep, dan istilah yang tidak cukup dijelaskan satu baris
- Runtime, integrasi, batasan, dan source fakta
- Pattern kode yang sudah terbukti, peta test, gotcha, dan ringkasan keputusan historis

### Canonical Template

Semua file context lahir dari skeleton fixed di [docs/TEMPLATES.md](docs/TEMPLATES.md) — nama section tidak boleh diubah (skill lain bergantung padanya). Ringkasannya:

| File | Isi inti | Writer |
|------|----------|--------|
| `AGENTS.md` | quick ref + profil agent project (root) | setup/ask-me/implement |
| `CLAUDE.md` | pointer `@AGENTS.md` untuk Claude Code (root) | setup |
| `CONTEXT.md` | file map, domain model, pattern, gotcha, riwayat keputusan (.workspace/context/) | setup/ask-me |
| `SRS.md` | baseline requirement global + Feature Registry + requirement fitur approved | `to-requirements` tunggal |
| `work/F-<id>.md` | work card sementara: requirement detail + task aktif | `to-requirements` + `to-tasks` + `implement` |
| `TRACKER.md` | progres eksekusi fitur | `to-tasks` + `implement` |
| `ADR.md` | keputusan final berformat | alur ADR per skill |
| `ARCHITECTURE.md` | module map + arah dependency (conditional) | setup/refresh |
| `SECURITY.md` | aturan proteksi, auth, env, agent safety (conditional) | setup/to-requirements |
| `CODE_STYLE.md` | stack, konvensi penamaan, checklist (conditional) | setup/to-requirements |
| `DATABASE.md` | provider/ORM, model approved, relasi, migrasi (conditional) | setup/to-requirements |
| `API.md` | base URL, endpoint approved, error shape, integrasi (conditional) | setup/to-requirements |

Rule isi saat grill/scan:
- Definisi ≤ 1 baris → AGENTS.md
- Penjelasan > 1 baris, contoh, edge case, file map lengkap → CONTEXT.md
- Requirement behavior (format EARS) lintas fitur/NFR → `.workspace/context/SRS.md` — bukan CONTEXT.md
- Requirement fitur yang sudah approved → `.workspace/context/SRS.md` Feature Requirements
- Detail requirement dan task yang masih dikerjakan → `.workspace/work/F-<id>.md`
- Section yang boleh di-refresh WAJIB marker `<!-- auto -->` di bawah heading
- Section tanpa marker = manual, `--refresh` tidak menyentuh
- Setiap bullet `<!-- auto -->` di stack docs wajib punya `Source:` path yang ada dan isinya sudah diverifikasi; `--refresh` menolak menulis klaim tanpa Source (lihat Protocol Missing Stack Docs di `../shared/COMMON.md`)

### Managed Block Rules untuk AGENTS.md

Managed block dibatasi oleh marker pembuka `<!-- workflow:start -->` dan penutup `<!-- workflow:end -->`.
Aturan integritas penulisan ke `AGENTS.md` di root:
1. **Validasi Marker (AC-04)**:
   - Hitung kemunculan marker `<!-- workflow:start -->` dan `<!-- workflow:end -->`.
   - Jika jumlah marker pembuka dan penutup tidak sama (tidak berpasangan), atau jika terdapat lebih dari satu pasangan marker (`count > 1`):
     - STOP seketika tanpa melakukan penulisan apa pun ke `AGENTS.md`.
     - Tampilkan error: `"AGENTS.md memiliki marker managed block yang tidak valid (marker ganda atau tidak berpasangan). Perbaiki manual sebelum melanjutkan."`
2. **File Ada Tanpa Managed Block (AC-02)**:
   - Jika `AGENTS.md` sudah ada tetapi belum mengandung marker:
     - Sisipkan managed block di awal file sebelum konten manual yang ada (dipisahkan baris baru).
     - DILARANG mengubah, menghapus, atau memformat ulang baris apa pun di luar managed block.
3. **File Baru**:
   - Jika `AGENTS.md` belum ada: buat file baru hanya berisi managed block dari template.
4. **Refresh Managed Block (AC-03)**:
   - Jika `AGENTS.md` sudah memiliki managed block valid:
     - `--refresh` HANYA menulis ulang section bermarker `<!-- auto -->` di DALAM managed block.
     - Section tanpa marker di dalam blok, serta SEMUA baris di luar managed block, TIDAK BOLEH disentuh.
     - `--refresh --force`: menulis ulang seluruh isi di dalam managed block dari template/scan, tetapi tetap TIDAK menyentuh baris apa pun di luar managed block.

## Step 1 — Check Setup Marker

Cek exist: `.workspace/project-meta.md`

- **Ada** → setup sudah jalan. Baca, tampilkan ringkasan (status, setup_date, context_updated, has_architecture, dan apakah Feature Registry/work card tersedia).
  - `--refresh` → Step 7
  - `--migrate-structure` → Step 6
  - Tanpa flag → beri tahu setup sudah tersedia, lalu arahkan ke `ask-me`.
- **Tidak ada** → cek dulu struktur lama: file `.workspace/context/PROJECT.md`, `.workspace/CONTEXT.md`, `.workspace/ADR.md`, `.workspace/ARCHITECTURE.md`, `.workspace/issue-tracker.md` langsung di root `.workspace/`, `.workspace/tracking/issue-tracker.md` (struktur v2), ATAU `.workspace/context/AGENTS.md` (sisa penamaan v3). Terdeteksi + flag `--migrate-structure` → jalankan Step 6 bagian A dulu, baru lanjut setup normal dari Step 2. Selain itu → lanjut Step 2.

## Step 2 — Detect Project Status

Dari isi folder + git history:

- Kosong / hanya scaffold bawaan (flutter create, create-react-app, next-app default, no modifikasi) → `status: new`
- Banyak file custom (+ git history > initial commit) → `status: existing`
- Bukan git repo → deteksi dari isi folder. Kosong/hanya `.workspace/` → `new`

## Step 3 — Populate Context Files and Conditional Stack Docs

Buat folder `.workspace/context/` kalau belum ada.

### Existing Project
- Scan ringan: struktur folder, dependency utama, pattern arsitektur
- Tulis profil project ke `AGENTS.md` di root project menggunakan managed block `<!-- workflow:start -->` ... `<!-- workflow:end -->` (lihat [template](docs/TEMPLATES.md#agentsmd)):
  - Jalankan validasi marker (AC-04): jika marker rusak/ganda → STOP dan laporkan error.
  - Jika belum ada `AGENTS.md`: buat baru dengan managed block dari template.
  - Jika `AGENTS.md` sudah ada tanpa managed block: sisipkan managed block di awal file; DILARANG mengubah baris mana pun di luar blok (AC-02).
  - Jika `AGENTS.md` sudah ada dengan managed block valid: lewati penulisan blok saat initial setup (hanya diperbarui saat `--refresh`).
  - Target isi blok ≤ ~100 baris; detail diarahkan sebagai pointer ke `.workspace/context/CONTEXT.md` (AC-05).
- Jika `CLAUDE.md` belum ada di root, buat `CLAUDE.md` berisi `@AGENTS.md`. Jika sudah ada, jangan ubah (AC-08).
- Isi `.workspace/context/CONTEXT.md` (file map, domain, teknis, pattern, test, gotchas) dari scan otomatis, ikuti **Aturan Split** dan struktur pada template. Setiap fakta penting sertakan `Source`. Jangan membuat `PROJECT.md`.
- `--no-context` → hanya AGENTS.md (dan CLAUDE.md bila belum ada); CONTEXT.md tidak dibuat; detail ringkas disisipkan sebagai section tambahan tanpa marker `<!-- auto -->` di managed block AGENTS.md; lewati stack docs (AC-07).
- `.workspace/context/ADR.md` → kosong, isi dari [template](docs/TEMPLATES.md#adrmd)
- `.workspace/context/SRS.md` → scaffold template kosong (Step 4); baseline diisi `to-requirements` setelah requirement disepakati
- **ARCHITECTURE.md conditional**: generate HANYA JIKA:
  - Scan deteksi >10 folder di `features/` ATAU multi-module/workspace ATAU user confirm "ya, buat ARCHITECTURE.md"
  - Skip: set `has_architecture: false` di project-meta.md, note di AGENTS.md: `architecture: standard feature-first (see AGENTS.md for conventions)`
- **Conditional Stack Docs (SECURITY, CODE_STYLE, DATABASE, API)**:
  - Tulis hanya jika ada bukti konkret di codebase; jangan tulis spekulasi atau placeholder kosong.
  - `CODE_STYLE.md` → generate dari `package.json`, linter/formatter config, atau konvensi bahasa aktual (`has_code_style: true`). Lewati jika `--no-context`.
  - `SECURITY.md` → generate HANYA JIKA terdeteksi auth provider, middleware auth, session handler, atau secret sensitif (`has_security: true`).
  - `DATABASE.md` → generate HANYA JIKA terdeteksi database provider, ORM, connection string, schema file, atau migrasi (`has_database: true`).
  - `API.md` → generate HANYA JIKA terdeteksi route handler, REST/GraphQL controller, public API, atau client integrasi pihak ketiga (`has_api: true`).
  - Jika suatu stack belum ada: file TIDAK dibuat, flag di `project-meta.md` diset `false`. File akan dibuat lazy oleh `to-requirements` saat fitur yang memperkenalkannya disetujui.

### New Project
- Delegasikan ke `ask-me` — jalankan grill dalam **Mode Bangun Domain** (interview loop)
- `ask-me` isi managed block `AGENTS.md` (root) + `.workspace/context/CONTEXT.md` (domain/teknis) + `ADR.md` langsung, ikuti **Aturan Split** dan letakkan fakta domain/integrasi/pattern/test/gotcha pada section CONTEXT yang sesuai.
- Buat `CLAUDE.md` di root berisi `@AGENTS.md` jika belum ada.
- Stack docs pada project baru:
  - `CODE_STYLE.md` langsung dibuat dari stack pilihan user saat interview.
  - `SECURITY.md`, `DATABASE.md`, dan `API.md` TIDAK langsung dibuat sebagai klaim final jika belum diimplementasi. Kebutuhan awal dimasukkan ke Global Requirements SRS (`GR-xx`) atau dicatat di `CONTEXT.md` sebagai rencana; file stack docs dibuat lazy saat fitur approved via `to-requirements`.
- `--no-context` → `ask-me` tulis profil dan detail ringkas ke managed block AGENTS.md saja (tanpa membuat CONTEXT.md dan tanpa marker `<!-- auto -->` pada detail ringkas; lewati stack docs, AC-07)
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
has_architecture: <true|false>
has_security: <true|false>
has_code_style: <true|false>
has_database: <true|false>
has_api: <true|false>
migrated_at: <YYYY-MM-DD>  # hanya kalau --migrate-structure jalan
```

## Step 6 — Migration (only `--migrate-structure`)

HANYA kalau flag `--migrate-structure`. Trigger: struktur lama terdeteksi (file `.workspace/context/PROJECT.md`, `.workspace/PROJECT.md`, `.workspace/CONTEXT.md`, `.workspace/ADR.md`, `.workspace/ARCHITECTURE.md`, `.workspace/issue-tracker.md` di root, `.workspace/tracking/issue-tracker.md` sisa v2, `.workspace/context/AGENTS.md` sisa penamaan v3, ATAU artifact fitur `.workspace/.scratch/<slug>/requirements.md`/`tasks.md`). Aturan TDD canonical berada di `../shared/TDD.md`.

A. Struktur lama terdeteksi → konsolidasi ke `AGENTS.md` root dan `context/`:
1. Buat folder `.workspace/context/` jika belum ada
2. Move & konsolidasi:
   - File legacy `PROJECT.md` (.workspace/context/PROJECT.md atau .workspace/PROJECT.md):
     - Analisis seluruh section yang ada di dalam file legacy `PROJECT.md`.
     - Petakan setiap section tanpa kecuali ke file target (AC-10):
       - Section quick reference (`Commands`, `Core Terms`, `Conventions`) → disalin ke managed block `AGENTS.md` di root project.
       - Section detail (`File Map`, `Advanced Details`, glossary, pola arsitektur, catatan kustom) → digabungkan ke `.workspace/context/CONTEXT.md`.
     - Tampilkan preview pemetaan ke user (tabel daftar section asal, target tujuan, dan status) sebelum menulis. Pastikan tidak ada section yang hilang atau terlewat.
     - Tulis hasil ke managed block `AGENTS.md` dan `.workspace/context/CONTEXT.md`.
     - Minta konfirmasi user sebelum menghapus file: `"Hapus file legacy PROJECT.md setelah migrasi berhasil? [y/N]"`. HANYA hapus `PROJECT.md` setelah user mengonfirmasi (AC-09).
   - `.workspace/CONTEXT.md` (root .workspace) → gabungkan ke `.workspace/context/CONTEXT.md`
   - `.workspace/ADR.md` → `.workspace/context/ADR.md`
   - `.workspace/ARCHITECTURE.md` (kalau ada) → `.workspace/context/ARCHITECTURE.md`
   - `.workspace/issue-tracker.md` → `.workspace/context/TRACKER.md`
   - `.workspace/tracking/issue-tracker.md` (sisa v2) → `.workspace/context/TRACKER.md`; folder `.workspace/tracking/` kosong setelahnya boleh dihapus
   - `.workspace/context/AGENTS.md` (sisa penamaan v3):
     - Perlakukan murni sebagai artifact migrasi konteks internal `.workspace/context/`, BUKAN sebagai `AGENTS.md` profil root project (AC-13).
     - Pindahkan dan gabungkan isinya ke `.workspace/context/CONTEXT.md`.
     - DILARANG menyalin atau menimpa isi file ini ke `AGENTS.md` root project.
   - File TDD lama: jangan dimigrasikan; gunakan `../shared/TDD.md` sebagai satu-satunya aturan TDD.
3. Buat `CLAUDE.md` di root (`@AGENTS.md`) jika belum ada.
4. Update `project-meta.md`: `migrated_at: <today>`, `has_architecture` berdasarkan keberadaan ARCHITECTURE.md

B. Artifact fitur legacy `.workspace/.scratch/<slug>/` terdeteksi → migrasikan secara eksplisit:
1. Baca requirements dan tasks yang ada; jangan menghapus source legacy pada tahap ini.
2. Cocokkan dengan Feature Registry yang sudah ada. Jika belum ada ID, alokasikan ID fitur berikutnya yang belum pernah dipakai; jangan gunakan ulang ID lama.
3. Gabungkan requirement detail dan task ke `.workspace/work/F-<id>.md`; pertahankan AC, `Ref`, status requirement, dan evidence yang tersedia.
4. Tampilkan mapping `<slug> → F-<id>` serta preview file sebelum menulis.
5. Setelah validasi dan konfirmasi user, hapus artifact legacy yang sudah berhasil dimigrasikan.

Print: "Migration complete. Structure updated (AGENTS.md + CONTEXT.md + work cards)."

## Step 7 — Refresh (only `--refresh`)

HANYA kalau flag `--refresh`:

0. **Deteksi Struktur Lama (AC-14)**:
   - Periksa apakah terdapat file `PROJECT.md` (di root atau di `.workspace/context/`), atau artifact struktur lama lainnya (`.workspace/CONTEXT.md`, `.workspace/issue-tracker.md`, sisa v3 `.workspace/context/AGENTS.md`).
   - JIKA terdeteksi struktur lama:
     - Tampilkan pesan saran: `"Struktur lama terdeteksi (ditemukan PROJECT.md atau artifact legacy). Jalankan 'setup-workflow --migrate-structure' untuk memigrasikan struktur ke AGENTS.md + CONTEXT.md."`
     - DILARANG memigrasikan file secara otomatis selama alur `--refresh` berlangsung (AC-14).
1. Re-scan codebase (existing) / re-grill ringkas via `ask-me` (new):
   - Validasi marker di `AGENTS.md`: jika marker rusak atau ganda (`count > 1` atau tidak berpasangan) → STOP dan laporkan error (AC-04).
   - Di dalam managed block `AGENTS.md`: perbarui HANYA section bertanda `<!-- auto -->`. DILARANG menyentuh section manual di dalam blok dan DILARANG mengubah baris apa pun di luar managed block (AC-03).
   - Di `CONTEXT.md`: perbarui section bertanda `<!-- auto -->`. Section manual tetap dipertahankan.
2. **Merge-safe**: section bertanda `<!-- auto -->` di-update/append dari scan baru; section manual (no marker) → SKIP, jangan sentuh
3. `--force` → full overwrite seluruh section di dalam managed block AGENTS.md, CONTEXT.md, serta stack docs aktif. SEMUA baris di luar managed block AGENTS.md tetap TIDAK disentuh.
4. Kalau `has_architecture: true` → re-generate `ARCHITECTURE.md` dari scan terbaru
5. Conditional stack docs (`has_security`, `has_code_style`, `has_database`, `has_api`):
   - Jika doc sudah aktif (`true`) → refresh hanya section `<!-- auto -->` berdasarkan kode terbaru
   - Jika doc belum aktif (`false`) tetapi scan baru menemukan bukti (misal baru ada DB/API) → buat file dari skeleton template dan update flag di `project-meta.md` menjadi `true`
6. Scaffold yang hilang dibuat ulang dari template (termasuk `.workspace/context/SRS.md` kalau belum ada — konten tidak disentuh; pastikan `CLAUDE.md` ada di root)
7. Update `project-meta.md`: `context_updated: <today>`
8. Print: "Context refreshed. Laporkan file yang benar-benar diperbarui: managed block AGENTS.md; CONTEXT.md jika aktif; ARCHITECTURE.md jika aktif; stack docs (SECURITY/CODE_STYLE/DATABASE/API) yang diperbarui."

## Step 8 — Complete

Beri tahu user:
- Setup complete / Refreshed / Migrated
- Status terdeteksi (new/existing)
- AGENTS.md & CLAUDE.md generated/updated: yes/no
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
Gunakan `--refresh` untuk update konteks, `--migrate-structure` untuk upgrade struktur lama ke AGENTS.md+CONTEXT.md dan migrasi artifact fitur ke work card.
