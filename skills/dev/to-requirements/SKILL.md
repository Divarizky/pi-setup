---
name: to-requirements
description: "Olah requirement jadi requirements per fitur + update SRS (single-writer). Format EARS, draft-first, approval gate. Dipanggil oleh user atau route workflow."
disable-model-invocation: true
---

# To Requirements

Sintesis + iterasi requirement, bukan interview panjang. Input dari percakapan aktif atau hasil `ask-me` grill. Output: dokumen requirements siap di-review user + sinkronisasi `.workspace/context/SRS.md`.

## Draft First

Kalau input percakapan sudah cukup (hasil grill/diskusi), tulis draf requirements lengkap dulu **tanpa tanya tambahan**, lalu iterasi revisi atas draf konkret — bukan interview kosong. Input masih tipis/ambigu → sarankan grill `ask-me` dulu sebelum menulis.

## Invocation

Dipanggil eksplisit atau melalui route `ask-me`: "buat requirements", "buat PRD", "tulis spec", "dokumentasikan fitur ini", "sintesis jadi requirements". "PRD" = alias lama untuk requirements — perlakukan sama.

## Prerequisites

[Prerequisites](../shared/COMMON.md#prerequisites) — `.workspace/project-meta.md` opsional. Tanpa workspace, gunakan universal mode: draft hanya ditampilkan di chat dan statusnya dicatat di respons.
`implement` mungkin sudah memiliki tracking tambahan. Project mode: cek `.workspace/.scratch/<slug>/tasks.md` sebagai sumber tambahan jika file tersedia. Universal mode: gunakan hanya context percakapan dan file yang user berikan.

## Step 1 — Context Before Exploration

Jangan eksplorasi codebase dulu. Gunakan Context Resolver dari `../shared/COMMON.md`.

1. Baca context project hanya jika tersedia: `PROJECT.md` untuk vocabulary, `CONTEXT.md` untuk detail, `ADR.md` untuk keputusan arsitektur, dan `.workspace/context/SRS.md` untuk global requirements yang sudah ada.
2. Project mode: cek `.workspace/.scratch/<slug>/tasks.md` jika tersedia.
3. Universal mode: gunakan keputusan dari percakapan dan file project relevan yang dapat diakses.
4. Eksplorasi codebase terfokus — maks 10 file atau 5 menit. Fokus area relevan fitur (baca nama file/directory di path terkait, bukan seluruh repo).

### Seam Detection Heuristic

Selama eksplorasi, deteksi seam — titik kode behavior bisa diganti tanpa edit langsung.

**Universal heuristic** (TS, Java, Kotlin, Dart, Go, C#, Swift):

- Grep `interface`, `abstract class`, `protocol`, `trait`
- Filter method publik ≤3 — seam kandidat terkuat
- Cek constructor/function parameter: parameter bertipe interface/abstract = injection point, preferred seam
- Cek >1 implementasi concrete dari interface sama — seam sudah terbukti dipakai

**Dynamic language fallback** (JS, Python, Ruby, PHP tanpa type hints):

- Grep file test: `mock(`, `patch(`, `stub(`, `Mock(`, `unittest.mock`
- Tiap mock object → dependency yang bisa diganti = seam tersembunyi
- Prioritaskan seam dari file paling banyak di-mock di test suite

**Output**: tulis 2-3 seam candidate. Jangan paksakan satu seam. Prioritaskan seam existing > seam baru.

## Step 2 — Write Requirements

Format dengan frontmatter YAML:

```yaml
---
version: 1.0.0
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
source: to-requirements # atau ask-me (grill dalam), manual
status: draft # lifecycle: draft → approved → superseded
supersedes: <path versi sebelumnya> # opsional, isi kalau update requirements lama
---
```

```
# <Feature Title>

## Problem
<Masalah dari perspektif user — 2-4 kalimat>

## Solution
<Solusi dari perspektif user — 3-5 kalimat>

## User Stories
(MUST) As a <role>, I want <goal>, so that <benefit>
(SHOULD) As a <role>, I want <goal>, so that <benefit>
(NICE) As a <role>, I want <goal>, so that <benefit>

Label prioritas: MUST (critical path), SHOULD (penting tapi bisa tunda), NICE (nice-to-have).

## Acceptance Criteria

Format **EARS** (Easy Approach to Requirements Syntax) — tiap kriteria satu baris, terukur, bisa jadi bahan test langsung:

```

1. WHEN <event/trigger> THEN <sistem> SHALL <respons terukur>
2. IF <precondition> THEN <sistem> SHALL <respons>
3. WHILE <state berlangsung> THEN <sistem> SHALL <respons> (opsional)
4. WHERE <kondisi lingkungan/konfigurasi> THEN <sistem> SHALL <respons> (opsional)

```

Contoh:
1. WHEN login sukses THEN sistem SHALL arahkan ke dashboard dalam < 2 detik
2. IF email tidak terdaftar THEN sistem SHALL tampilkan error "email atau password salah"
3. WHEN sesi expired THEN sistem SHALL redirect ke login dengan pesan "sesi berakhir"

## Implementation Decisions
**Final** (sudah disepakati, tidak bisa diganti tanpa ADR):
- <Keputusan 1> — alasan

**Open** (masih perlu validasi saat implementasi):
- <Keputusan 2> — apa yang belum jelas

## Testing Decisions
- **Seam(s)**: <1-3 seam, prioritaskan utama. Tiap seam: file + interface + method count>
- **Test Strategy**: <unit / integration / e2e — yang mana dan coverage target>
- **Environment**: <local / staging / env specific requirement>

## Out of Scope
- <Yang eksplisit tidak dikerjakan di requirements ini>
- <Future scope — catat, tidak dibahas di sini>

## Further Notes (optional)
<Catatan tambahan penting dibawa ke implementasi>
```

### Content Rules

- **Jangan sertakan file path atau code snippet spesifik** — cepat basi. Semua deskripsi pakai prosa.
  - Schema: "User punya field: email (string), passwordHash (string), role enum (admin|user)."
  - State machine: "4 state: loading, error, empty, data. Transisi loading→data (sukses) atau loading→error (timeout)."
  - Decision table: "Kalau role admin DAN status active → izinkan. Kalau role user DAN status suspended → tolak dengan pesan 'akun dinonaktifkan'."
  - Butuh presisi teknis → link ke file dengan snapshot commit: `// snapshot at a7f3e2`
- **User Stories cover semua aspek fitur** — prioritas MUST jelas untuk critical path implementasi.

## Step 3 — Requirements Output Location

### Project Mode

Gunakan `.workspace/.scratch/<feature-slug>/requirements.md`.

- **Belum ada**: tulis baru dengan `version: 1.0.0`, `status: draft`, `created: hari ini`.
- **Sudah ada**: baca isinya. Update konten, increment `version` minor, update `updated`, pertahankan `created` serta `source`. `supersedes` hanya diisi kalau requirements dipindah ke path/file baru; update in-place dikosongkan.

### Universal Mode

Jangan membuat atau memperbarui file requirements. Simpan draft hanya dalam context sesi, tampilkan di chat, dan gunakan `version`/`status` sebagai metadata respons.

Catatan: requirements universal tidak tersedia otomatis di sesi berikutnya. Tawarkan `setup-workflow` jika user membutuhkan persistence.

requirements tidak masuk siklus triage task; triage dilakukan oleh `to-tasks`. requirements memiliki lifecycle sendiri melalui metadata `version` dan `status`.

## Step 4 — Self-Validation

Sebelum kasih ke user, cek:

1. **Error check**: Ada placeholder `<...>` yang belum keisi? → tanya user
2. **Alignment check**: Semua Problem punya minimal 1 User Story address? Semua Acceptance Criteria trace ke Solution?
3. **Seam check**: Seam yang dipilih benar-benar ada di codebase (bukan khayalan)? Seam baru → sebut butuh dibuat.
4. **Version check**: `version` di-increment benar (baru: 1.0.0, update: minor bump).

Ada gap → tanyakan user, jangan publish dulu.

## Step 5 — Present and Approve

Tampilkan requirements ke user:

```
Project mode:
Draft requirements: `.workspace/.scratch/<slug>/requirements.md` v<version>

Universal mode:
Draft requirements: ditampilkan di chat, v<version>

[ringkasan — Problem + Solution + Acceptance Criteria]

Status sekarang: draft
Approve? (y/n)
```

- **y** → Project: update `status: approved` di frontmatter, jalankan Step 6 (sinkronisasi SRS). Universal: catat `status: approved` di respons + kontribusi SRS di chat. Lanjut **chain to-tasks** (lihat bawah).
- **n** / revisi → update konten di file (Project) atau context sesi (Universal). Increment version minor, `status` tetap `draft`. Update Feature Index status jadi draft bila sebelumnya approved. Tanya lagi sampai approve.
- **Perubahan besar** → tulis ulang section relevan, bump version, present ulang.

### Chain to To-Tasks

Setelah requirements approved, tanya:

> requirements sudah approved. Lanjut breakdown ke task via `to-tasks`? (y/n)

- **Tidak** → Project: beri tahu path requirements. Universal: beri tahu requirements hanya tersedia di context sesi. Keduanya menyarankan invoke `to-tasks` kapan saja.
- **Ya** → **jangan auto-invoke `to-tasks`**. Jalankan manual di sesi yang sama dengan requirements sebagai input inline.
  1. Baca `to-tasks/SKILL.md`.
  2. Jalankan proposal dan iterasi vertical slice.
  3. Project: tulis `tasks.md` dan update tracker.
  4. Universal: tampilkan checklist task di chat dan catat status breakdown di respons.

Chain manual ini hanya untuk kontinuitas sesi. User bisa invoke `to-tasks` langsung kapan saja.

## Step 6 — Sync SRS (Project Mode)

`to-requirements` adalah **single-writer** `.workspace/context/SRS.md` setelah seed awal dari `setup-workflow`. SRS tipis: hanya Global Requirements (NFR/cross-feature, format EARS) + Feature Index. Detail fitur TIDAK pernah masuk SRS — itu ranah requirements.

Saat requirements approved:

1. **Feature Index**: tambah/baris `<slug> | <judul> | approved | .scratch/<slug>/requirements.md`. Slug existing → update statusnya.
2. **Global Requirements**: requirement lintas fitur / NFR baru yang muncul saat grill (security, perf, compliance) → tambahkan baris EARS. Requirement yang cuma spesifik satu fitur → tetap di requirements, jangan naik ke SRS.
3. requirements revisi turun dari approved → status di index ikut diturunkan.

Universal mode: tampilkan kontribusi SRS di chat (global requirement + entry index), jangan menulis file.

Jangan sentuh `.workspace/context/TRACKER.md` — index eksekusi itu ranah `to-tasks` (buat entry) dan `implement` (counter).

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Banyak keputusan ambigu → `ask-me` grill dalam dulu, baru `to-requirements`. requirements approved, mau breakdown task → chain ke `to-tasks` lewat Step 5. Butuh persistence lintas sesi → `setup-workflow`.
