---
name: to-prd
description: "Sintesis percakapan/hasil grill jadi PRD (full local). Auto-trigger saat user bilang: \"buat PRD\", \"tulis spec\", \"dokumentasikan fitur ini\", \"sintesis jadi PRD\". Jangan trigger kalau user baru diskusi eksplorasi tanpa keputusan desain — tanya dulu \"mau saya dokumentasikan sebagai PRD?\". Tanpa interview — sintesis dari konteks yang sudah dibahas."
model-invocation: enabled
---

# To PRD

Sintesis, bukan interview. Input dari percakapan aktif atau hasil `ask-me` grill. Output: dokumen PRD siap di-review user.

## Chat Trigger

Auto-trigger: "buat PRD", "tulis spec", "dokumentasikan fitur ini", "sintesis jadi PRD".

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — **hard-check**: `.workspace/project-meta.md` harus ada. Tidak ada → arahkan ke `setup-workflow`, stop.
`implement` sudah tulis tracking minimal di `.workspace/.scratch/<slug>/tasks.md`? Baca dulu — sumber tambahan.

## Step 1 — Context Sebelum Eksplorasi

Jangan eksplorasi codebase dulu. Urutan:

1. Baca `.workspace/context/AGENT.md` (quick) + `.workspace/context/CONTEXT.md` (detail) — vocabulary domain, catat istilah relevan
2. Baca `.workspace/context/ADR.md` — keputusan arsitektur area terkait, jangan re-litigasi tanpa alasan kuat
3. Cek `.workspace/.scratch/<slug>/tasks.md` — kalau ada dari `implement` (tracking minimal), baca sebagai referensi
4. Eksplorasi codebase terfokus — maks 10 file atau 5 menit. Fokus area relevan fitur (baca nama file/directory di path terkait, bukan seluruh repo)

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

## Step 3 — Tulis ke PRD.md

Deteksi: `.workspace/.scratch/<feature-slug>/PRD.md` sudah ada?

- **Belum ada**: tulis baru dengan `version: 1.0.0`, `status: draft`, `created: hari ini`
- **Sudah ada**: baca isinya. Update konten (jangan overwrite mental). Increment `version` (minor, misal `1.1.0`). Tambah `supersedes` dengan path versi sebelumnya. Update `updated: hari ini`. Jangan ubah `created`. Source field tetap dari asal pertama.

Catatan: `implement` bisa tulis tracking minimal di `.scratch/<slug>/tasks.md` untuk fitur dari konteks — referensi, bukan overwrite PRD.

PRD.md tidak masuk siklus triage task (triage di level task via `to-issues`, bukan PRD). Tapi PRD punya lifecycle sendiri via status frontmatter.

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
Draft PRD: .workspace/.scratch/<slug>/PRD.md v<version>

[ringkasan — Problem + Solution + Acceptance Criteria]

Status sekarang: draft
Approve? (y/n)
```

- **y** → update `status: approved` di frontmatter. Lanjut **chain to-issues** (lihat bawah)
- **n** / revisi → update konten sesuai input. Increment version (minor bump). `status` tetap `draft`. Tanya lagi sampai approve.
- **Perubahan besar** → tulis ulang section relevan, bump version, present ulang.

### Chain ke To-Issues

Setelah PRD approved, tanya:

> PRD sudah approved. Lanjut breakdown ke task via `to-issues`? (y/n)

- **Tidak** → beri tahu path file PRD + saran: "Invoke `to-issues` kapan saja mau breakdown task."
- **Ya** → **jangan auto-invoke `to-issues`** (biar tetap 1 sesi, no context loss). Sebagai gantinya:
  1. Baca `to-issues/SKILL.md` — pahami Step 1 (deteksi subagent), Step 2 (vertical slice), Step 3 (propose slicing + iterasi), Step 4 (tulis tasks.md)
  2. Jalankan Step 1 (deteksi subagent saja — input source sudah diketahui: PRD) lalu Step 2-4 `to-issues` manual di sesi ini
  3. Tulis `.workspace/.scratch/<slug>/tasks.md` format & mekanisme sama persis `to-issues`
  4. Update `.workspace/tracking/issue-tracker.md` — entry slug jadi `status: open`
  5. Beri tahu user: PRD approved + tasks.md siap. Path kedua file.

Chain manual ini hanya untuk kontinuitas sesi. User bisa invoke `to-issues` langsung kapan saja (skill ini `model-invocation: enabled`).

## Saran Skills Lain

[Cross-ref](../shared/COMMON.md#saran-skills-lain) — Banyak keputusan ambigu → `ask-me` grill dalam dulu, baru `to-prd`. PRD approved, mau breakdown task → chain ke `to-issues` lewat Step 5. Belum ada `project-meta.md` → `setup-workflow` dulu.