---
name: to-requirements
description: "Olah requirement jadi requirements per fitur + update SRS (single-writer). Format EARS, draft-first, approval gate. Dipanggil oleh user atau route workflow."
disable-model-invocation: true
---

# To Requirements

Sintesis + iterasi requirement, bukan interview panjang. Input dari percakapan aktif atau hasil `ask-me` grill. Output: work card fitur siap di-review user + sinkronisasi baseline `.workspace/context/SRS.md`.

## Draft First

Kalau input percakapan sudah cukup (hasil grill/diskusi), tulis draf requirements lengkap dulu **tanpa tanya tambahan**, lalu iterasi revisi atas draf konkret — bukan interview kosong. Input masih tipis/ambigu → sarankan grill `ask-me` dulu sebelum menulis.

## Invocation

Dipanggil eksplisit atau melalui route `ask-me`: "buat requirements", "tulis spec", "dokumentasikan requirement fitur ini", "susun requirement fitur ini", "sintesis jadi requirements".

## Prerequisites

[Prerequisites](../shared/COMMON.md#prerequisites) — `.workspace/project-meta.md` opsional. Tanpa workspace, gunakan universal mode: draft hanya ditampilkan di chat dan statusnya dicatat di respons.
`implement` mungkin sudah memiliki tracking tambahan. Project mode: baca Feature Registry di `.workspace/context/SRS.md` dan work card `.workspace/work/F-<id>.md` jika tersedia. Universal mode: gunakan hanya context percakapan dan file yang user berikan.

## Step 1 — Context Before Exploration

Jangan eksplorasi codebase dulu. Gunakan Context Resolver dari `../shared/COMMON.md`.

1. Baca context project hanya jika tersedia: `AGENTS.md` (root) untuk quick reference, `CONTEXT.md` (`.workspace/context/`) untuk detail, `ADR.md` untuk keputusan arsitektur, `.workspace/context/SRS.md` untuk baseline requirements/Feature Registry, dan conditional stack docs (`SECURITY.md`, `CODE_STYLE.md`, `DATABASE.md`, `API.md`) bila relevan.
2. Jika ada stack doc yang belum aktif (`has_*: false`) tetapi fitur baru membutuhkannya (misal fitur butuh DB tapi `DATABASE.md` belum ada), ikuti **Protocol Missing Stack Docs** di `../shared/COMMON.md`: catat model/endpoint/konvensi sebagai `Proposed` di `Implementation Decisions → Open`, dan siapkan AC bootstrap.
3. Project mode: cari feature berdasarkan `F-<id>` di Feature Registry dan baca `.workspace/work/F-<id>.md` jika tersedia.
4. Universal mode: gunakan keputusan dari percakapan dan file project relevan yang dapat diakses.
5. Eksplorasi codebase terfokus — maks 10 file atau 5 menit. Fokus area relevan fitur (baca nama file/directory di path terkait, bukan seluruh repo).

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
id: F-01
version: 1.0.0
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
source: to-requirements  # atau ask-me (grill dalam), manual
status: draft  # lifecycle: draft → approved → superseded
supersedes: <F-id/version sebelumnya>  # opsional, jangan pakai path work card
---
```

```markdown
# F-01 — <Feature Title>

## Clarifications
<!-- Jawaban atas ambiguitas dari grill/draft. Tiap sesi bertanggal; jangan dihapus saat revisi. -->
### Session <YYYY-MM-DD>
- Q: <pertanyaan> → A: <jawaban>

## Problem
<Masalah dari perspektif user — 2-4 kalimat>

## Solution
<Solusi dari perspektif user — 3-5 kalimat>

## User Stories
### User Story 1 - <judul> (Priority: P1)
As a <role>, I want <goal>, so that <benefit>.
Why this priority: <alasan prioritas>
Independent Test: <cara menguji story ini secara mandiri, tanpa menunggu story lain>

### User Story 2 - <judul> (Priority: P2)
<sama seperti di atas>

Label prioritas: P1 (MUST, critical path), P2 (SHOULD, penting tapi bisa tunda), P3 (NICE, nice-to-have). Tiap story wajib punya `Why this priority` dan `Independent Test`.

## Edge Cases
- <kasus batas atau kegagalan>
  * Penanganan: <perilaku sistem yang diharapkan>

## Acceptance Criteria

Format **EARS** (Easy Approach to Requirements Syntax) — tiap kriteria satu baris, terukur, bisa jadi bahan test langsung:

```
1. WHEN <event/trigger> THEN <sistem> SHALL <respons terukur>
2. IF <precondition> THEN <sistem> SHALL <respons>
3. WHILE <state berlangsung> THEN <sistem> SHALL <respons>  (opsional)
4. WHERE <kondisi lingkungan/konfigurasi> THEN <sistem> SHALL <respons>  (opsional)
```

Contoh:
1. AC-01: WHEN login sukses THEN sistem SHALL arahkan ke dashboard dalam < 2 detik
2. AC-02: IF email tidak terdaftar THEN sistem SHALL tampilkan error "email atau password salah"
3. AC-03: WHEN sesi expired THEN sistem SHALL redirect ke login dengan pesan "sesi berakhir"

## Functional Requirements
- REQ-01: Sistem MUST <kewajiban terukur>.
- REQ-02: <sama seperti di atas>

## Success Criteria
- SC-01: <target terukur, mis. latensi, persentase, atau kondisi yang bisa diuji>

## Assumptions
- <fakta lingkungan yang dipegang, mis. target deployment atau ketersediaan library>

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

## Tasks
<!-- Diisi `to-tasks`; task aktif tetap berada di work card ini. -->

## Evidence
<!-- Test/commit/validasi setelah implementasi. -->
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

Gunakan work card `.workspace/work/F-<id>.md`.

- **ID baru**: baca Feature Registry, alokasikan ID `F-<id>` berikutnya yang belum pernah dipakai; jangan memakai ulang ID walaupun work card lama sudah dihapus. Buat `.workspace/work/` bila belum ada.
- **Feature existing**: baca work card dan SRS Feature Requirements berdasarkan ID; update konten dan increment `version` minor.
- **Metadata**: pertahankan `id`, `created`, dan `source`; update `updated`. `supersedes` hanya berisi ID/version requirement sebelumnya, bukan path.
- **Draft**: tulis seluruh requirement detail ke work card dengan `status: draft`; SRS belum dianggap baseline approved.
- **Approved**: salin requirement yang disetujui ke SRS Feature Requirements melalui Step 6. Work card tetap boleh ada sampai task selesai lalu dapat dihapus setelah konfirmasi user.

SRS yang hilang atau formatnya rusak → jangan overwrite diam-diam. Tampilkan masalah, tawarkan scaffold dari template, dan minta konfirmasi sebelum membuat atau memperbaikinya.

### Universal Mode

Jangan membuat atau memperbarui file requirements. Simpan draft hanya dalam context sesi, tampilkan di chat, dan gunakan `version`/`status` sebagai metadata respons.

Catatan: requirements universal tidak tersedia otomatis di sesi berikutnya. Tawarkan `setup-workflow` jika user membutuhkan persistence.

requirements tidak masuk siklus triage task; triage dilakukan oleh `to-tasks`. requirements memiliki lifecycle sendiri melalui metadata `version` dan `status`.

## Step 4 — Self-Validation

Sebelum kasih ke user, cek:
1. **Error check**: Ada placeholder `<...>` yang belum keisi? → tanya user
2. **Alignment check**: Semua Problem punya minimal 1 User Story address? Semua Acceptance Criteria trace ke Solution?
3. **Bootstrap check**: Jika fitur memperkenalkan stack baru yang belum aktif (`has_*: false`), apakah ada minimal 1 AC bootstrap terukur (migrasi skema / base endpoint / auth rule) dan usulan masuk `Implementation Decisions → Open`?
4. **Seam check**: Seam yang dipilih benar-benar ada di codebase (bukan khayalan)? Seam baru → sebut butuh dibuat.
5. **Version check**: `version` di-increment benar (baru: 1.0.0, update: minor bump).
6. **ID check**: `F-<id>` belum pernah dipakai; setiap AC memiliki ID stabil (`AC-01`, `AC-02`, dst.).
7. **SRS check**: saat approval, Feature Registry memakai status lifecycle (`draft|approved|superseded`) dan Feature Requirements tetap berupa requirement terukur, bukan detail implementasi.
8. **Story check**: setiap User Story punya Priority (P1–P3), `Why this priority`, dan `Independent Test`.
9. **Edge & REQ check**: setiap Edge Case punya `Penanganan`; setiap `REQ-xx` dipetakan ke minimal satu AC; setiap AC dipetakan ke `REQ-xx` atau `GR-xx`.
10. **Clarification & SC check**: jawaban di `Clarifications` tidak bertentangan dengan AC, REQ, atau Assumptions; setiap `SC-xx` terukur (angka, persentase, atau kondisi yang bisa diuji).

Ada gap → tanyakan user, jangan publish dulu.

## Step 5 — Present and Approve

Tampilkan requirements ke user:

```
Project mode:
Draft work card: `.workspace/work/F-<id>.md` v<version>

Universal mode:
Draft work card: ditampilkan di chat, v<version>

[ringkasan — Problem + Solution + Acceptance Criteria]

Status sekarang: draft
Pilih: [1] Approve saja  [2] Approve + lanjut to-tasks  [3] Revisi
```

- **[1]** → Project: update `status: approved` di frontmatter, jalankan Step 6 (sinkronisasi SRS). Universal: catat `status: approved` di respons + kontribusi SRS di chat. Beri tahu cara invoke `to-tasks` kapan saja.
- **[2]** → lakukan [1], lalu langsung **chain to-tasks** (lihat bawah) tanpa pertanyaan tambahan.
- **[3]** / revisi → update work card (Project) atau context sesi (Universal). Increment version minor, `status` tetap `draft`. Jika feature sebelumnya approved, tandai baseline SRS sebagai draft dan minta approval ulang. Tanya lagi sampai approve.
- **Perubahan besar** → tulis ulang section relevan, bump version, present ulang.
- **Supersede** → jangan hapus entry SRS; tandai feature dan requirement terkait `superseded`, isi `supersedes` dengan ID/version pengganti bila ada.

### Chain to To-Tasks

Hanya dipakai bila user memilih [1] di Step 5 lalu belakangan meminta breakdown. Tanya sekali:

> requirements sudah approved. Lanjut breakdown ke task via `to-tasks`? (y/n)

- **Tidak** → Project: beri tahu path work card. Universal: beri tahu work card hanya tersedia di context sesi. Keduanya menyarankan invoke `to-tasks` kapan saja.
- **Ya** → **jangan auto-invoke `to-tasks`**. Jalankan manual di sesi yang sama dengan requirement sebagai input inline.
  1. Baca `to-tasks/SKILL.md`. Kirim paket chain sesuai [Chain Pattern](../shared/COMMON.md#chain-pattern).
  2. Jalankan proposal dan iterasi vertical slice.
  3. Project: tulis task ke section `## Tasks` pada work card dan update tracker.
  4. Universal: tampilkan checklist task di chat dan catat status breakdown di respons.

Chain manual ini hanya untuk kontinuitas sesi. User bisa invoke `to-tasks` langsung kapan saja.

## Step 6 — Sync SRS (Project Mode)

`to-requirements` adalah **single-writer** `.workspace/context/SRS.md` setelah seed awal dari `setup-workflow`. SRS menjadi baseline SOT: Global Requirements, Feature Registry, dan Feature Requirements approved. Work card menyimpan detail draft/kerja dan boleh dihapus; requirement approved tidak boleh hilang dari SRS.

Saat requirements approved:
1. **Feature Registry**: tambah atau update baris `F-<id>` dengan judul, status `approved`, dan tanggal update. Jangan simpan path work card.
2. **Feature Requirements**: sinkronkan scope, requirement `REQ-xx`, `SC-xx`, Edge Cases (sebagai verification), dan verification dari work card. `REQ-xx` dan `SC-xx` scoped di dalam `F-xx`. `Clarifications` dan `Assumptions` tetap di work card; keputusan yang mengikat dicatat di Feature Requirements.
3. **Global Requirements**: requirement lintas fitur/NFR baru → beri ID `GR-xx`, deduplikasi terhadap requirement existing, lalu tambahkan dalam format EARS. Requirement spesifik fitur tetap di blok fitur.
4. **Lazy Stack Docs Generation**: Jika fitur yang di-approve memperkenalkan stack baru yang sebelumnya `has_*: false` (misal DB/API/Auth pertama), buat file stack doc terkait (`DATABASE.md`, `API.md`, `SECURITY.md`) dari skeleton di `TEMPLATES.md`. Isi HANYA dengan model, route, atau aturan yang sudah approved di fitur ini (bukan spekulasi). Update flag terkait di `project-meta.md` menjadi `true`.
5. **Revisi**: jika baseline berubah, update requirement terkait dan bump versi work card; status SRS kembali `draft` sampai approval ulang.
6. **Supersede**: tandai entry/requirement lama `superseded`, jangan menghapusnya; referensikan ID pengganti jika ada.
7. **Traceability**: setiap `AC-xx` work card harus dapat dipetakan ke `REQ-xx` atau `GR-xx` yang relevan.

Universal mode: tampilkan kontribusi SRS di chat (global requirement + Feature Registry + Feature Requirements), jangan menulis file.

Jangan sentuh `.workspace/context/TRACKER.md` — index eksekusi itu ranah `to-tasks` (buat entry) dan `implement` (counter).

## Output Contract

Tutup workflow dengan:

```text
Changes: <work card dan/atau SRS yang dibuat/diubah; none jika Universal mode>
Validation: <alignment, EARS, ID, traceability, dan approval yang dijalankan>
Status: <complete | partial | blocked | cancelled>
Risks/Limitations: <none atau daftar singkat>
Next Step: <to-tasks, revisi, atau aksi lain; tanpa auto-apply>
```

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Banyak keputusan ambigu → `ask-me` grill dalam dulu, baru `to-requirements`. requirements approved, mau breakdown task → chain ke `to-tasks` lewat Step 5. Butuh persistence lintas sesi → `setup-workflow`.