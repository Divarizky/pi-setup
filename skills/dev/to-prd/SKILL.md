---
name: to-prd
description: "Sintesis percakapan/hasil grill jadi PRD. Dipanggil oleh user atau route workflow; tanpa interview — sintesis dari konteks yang sudah dibahas."
disable-model-invocation: true
---

# To PRD

Sintesis, bukan interview. Input dari percakapan aktif atau hasil `ask-me` grill. Output: dokumen PRD siap di-review user.

## Invocation

Dipanggil eksplisit atau melalui route `ask-me`: "buat PRD", "tulis spec", "dokumentasikan fitur ini", "sintesis jadi PRD".

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — `.workspace/project-meta.md` opsional. Tanpa workspace, gunakan universal mode: draft hanya ditampilkan di chat dan statusnya dicatat di respons.
`implement` mungkin sudah memiliki tracking tambahan. Project-aware mode: cek `.workspace/.scratch/<slug>/tasks.md` sebagai sumber tambahan jika file tersedia. Universal mode: gunakan hanya context percakapan dan file yang user berikan.

## Step 1 — Context Sebelum Eksplorasi

Jangan eksplorasi codebase dulu. Gunakan Context Resolver dari `../shared/COMMON.md`.

1. Baca context project hanya jika tersedia: `AGENT.md` untuk vocabulary, `CONTEXT.md` untuk detail, dan `ADR.md` untuk keputusan arsitektur.
2. Project-aware mode: cek `.workspace/.scratch/<slug>/tasks.md` jika tersedia.
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

## Step 2 — Tulis PRD

Format dengan frontmatter YAML:

```yaml
---
version: 1.0.0
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
source: to-prd  # atau ask-me (grill dalam), manual
status: draft  # lifecycle: draft → approved → superseded
supersedes: <path versi sebelumnya>  # opsional, isi kalau update PRD lama
---
```

```
# <Judul Fitur>

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
- <Kondisi konkret, terukur — fitur selesai kalau semua terpenuhi>
- Contoh: "User login email+password valid — test e2e pass"
- Contoh: "Error message muncul saat email tidak terdaftar"

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
- <Yang eksplisit tidak dikerjakan di PRD ini>
- <Future scope — catat, tidak dibahas di sini>

## Further Notes (opsional)
<Catatan tambahan penting dibawa ke implementasi>
```

### Aturan Konten
- **Jangan sertakan file path atau code snippet spesifik** — cepat basi. Semua deskripsi pakai prosa.
  - Schema: "User punya field: email (string), passwordHash (string), role enum (admin|user)."
  - State machine: "4 state: loading, error, empty, data. Transisi loading→data (sukses) atau loading→error (timeout)."
  - Decision table: "Kalau role admin DAN status active → izinkan. Kalau role user DAN status suspended → tolak dengan pesan 'akun dinonaktifkan'."
  - Butuh presisi teknis → link ke file dengan snapshot commit: `// snapshot at a7f3e2`
- **User Stories cover semua aspek fitur** — prioritas MUST jelas untuk critical path implementasi.

## Step 3 — Tulis PRD

### Project-aware mode

Gunakan `.workspace/.scratch/<feature-slug>/PRD.md`.

- **Belum ada**: tulis baru dengan `version: 1.0.0`, `status: draft`, `created: hari ini`.
- **Sudah ada**: baca isinya. Update konten, increment `version` minor, isi `supersedes`, update `updated`, dan pertahankan `created` serta `source`.

### Universal mode

Jangan membuat atau memperbarui file PRD. Simpan draft hanya dalam context sesi, tampilkan di chat, dan gunakan `version`/`status` sebagai metadata respons.

Catatan: PRD universal tidak tersedia otomatis di sesi berikutnya. Tawarkan `setup-workflow` jika user membutuhkan persistence.

PRD tidak masuk siklus triage task; triage dilakukan oleh `to-issues`. PRD memiliki lifecycle sendiri melalui metadata `version` dan `status`.

## Step 4 — Validasi Diri

Sebelum kasih ke user, cek:
1. **Error check**: Ada placeholder `<...>` yang belum keisi? → tanya user
2. **Alignment check**: Semua Problem punya minimal 1 User Story address? Semua Acceptance Criteria trace ke Solution?
3. **Seam check**: Seam yang dipilih benar-benar ada di codebase (bukan khayalan)? Seam baru → sebut butuh dibuat.
4. **Version check**: `version` di-increment benar (baru: 1.0.0, update: minor bump).

Ada gap → tanyakan user, jangan publish dulu.

## Step 5 — Present & Approve

Tampilkan PRD ke user:

```
Project-aware mode:
Draft PRD: `.workspace/.scratch/<slug>/PRD.md` v<version>

Universal mode:
Draft PRD: ditampilkan di chat, v<version>

[ringkasan — Problem + Solution + Acceptance Criteria]

Status sekarang: draft
Approve? (y/n)
```

- **y** → Project-aware: update `status: approved` di frontmatter. Universal: catat `status: approved` di respons. Lanjut **chain to-issues** (lihat bawah).
- **n** / revisi → update konten di file (Project-aware) atau context sesi (Universal). Increment version minor, `status` tetap `draft`. Tanya lagi sampai approve.
- **Perubahan besar** → tulis ulang section relevan, bump version, present ulang.

### Chain ke To-Issues

Setelah PRD approved, tanya:

> PRD sudah approved. Lanjut breakdown ke task via `to-issues`? (y/n)

- **Tidak** → Project-aware: beri tahu path PRD. Universal: beri tahu PRD hanya tersedia di context sesi. Keduanya menyarankan invoke `to-issues` kapan saja.
- **Ya** → **jangan auto-invoke `to-issues`**. Jalankan manual di sesi yang sama dengan PRD sebagai input inline.
  1. Baca `to-issues/SKILL.md`.
  2. Jalankan proposal dan iterasi vertical slice.
  3. Project-aware: tulis `tasks.md` dan update tracker.
  4. Universal: tampilkan checklist task di chat dan catat status breakdown di respons.

Chain manual ini hanya untuk kontinuitas sesi. User bisa invoke `to-issues` langsung kapan saja.

## Saran Skills Lain

[Workflow](../WORKFLOW.md) — Banyak keputusan ambigu → `ask-me` grill dalam dulu, baru `to-prd`. PRD approved, mau breakdown task → chain ke `to-issues` lewat Step 5. Butuh persistence lintas sesi → `setup-workflow`.