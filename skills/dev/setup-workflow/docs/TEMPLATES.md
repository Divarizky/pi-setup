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
Domain/pattern/gotcha → `CONTEXT.md` · Requirement baseline → `SRS.md` · Work aktif → `work/F-<id>.md` · Progres → `TRACKER.md` · Keputusan final → `ADR.md`
```

---

## CONTEXT.md

Path: `.workspace/context/CONTEXT.md`

```markdown
# CONTEXT — <name>

Pengetahuan domain dan teknis project — lazy-load saat perlu. Quick ref ada di PROJECT.md.

## Domain Model <!-- auto -->
### <konsep>
- **Meaning:** <arti dalam domain>
- **Relations:** <hubungan dengan konsep lain>
- **Source:** <file, API, atau keputusan yang memverifikasi fakta>

## Runtime and Integrations <!-- auto -->
- <runtime/integrasi> — <peran, batasan, dan source>

## Code Patterns <!-- auto -->
- <pattern> — <kapan dipakai, batasan, dan source>

## Testing Map <!-- auto -->
- <area> — <boundary test, command, atau coverage yang relevan>

## Gotchas <!-- auto -->
- <jebakan> — <cara menghindarinya dan source>

## Historical Decisions <!-- auto -->
- <ringkasan> — detail di `ADR-N` jika keputusan bersifat final

## References
- <link eksternal / template / sample>
```

Aturan: `CONTEXT.md` hanya berisi fakta domain, integrasi, pola kode, peta test, dan gotcha. Requirement normatif masuk SRS; keputusan final masuk ADR; progres masuk TRACKER. Setiap fakta penting menyebutkan `Source`. Definisi yang muat satu baris naikkan ke PROJECT.md (Aturan Split).

---

## SRS.md

Path: `.workspace/context/SRS.md`

```markdown
# SRS — <name>

Software Requirements Specification dan baseline requirement project.
Requirement permanen disimpan di sini; work card hanya artifact kerja sementara.
Single-writer konten requirement: `to-requirements`.

## Global Requirements
<!-- Requirement lintas fitur/NFR. Setiap item memakai ID GR-xx dan format EARS. -->
<!-- kosong sampai requirement global disepakati -->

## Feature Registry
<!-- ID | Feature | status lifecycle | updated -->
<!-- status: draft | approved | superseded; jangan memakai status progres seperti done -->
<!-- kosong sampai feature requirement disetujui -->

## Feature Requirements
<!-- Requirement approved per feature. ID REQ-xx scoped di dalam F-xx. -->
<!-- kosong sampai feature requirement disetujui -->
```

SRS tidak menyimpan path `work/F-<id>.md`. Status di Feature Registry adalah lifecycle requirement, bukan progres eksekusi; progres ada di TRACKER.md. Feature ID tidak boleh dipakai ulang walaupun work card dihapus.

### Example: first feature (documentation example only)

```markdown
## Feature Registry
| ID | Feature | Status | Updated |
|---|---|---|---|
| F-01 | Login OAuth | approved | YYYY-MM-DD |

## Feature Requirements
### F-01 — Login OAuth
- **Scope:** User dapat login dengan OAuth.
- **REQ-01:** WHEN autentikasi berhasil THEN sistem SHALL membuat sesi user.
- **REQ-02:** IF autentikasi gagal THEN sistem SHALL menampilkan error yang dapat dipahami.
- **Verification:** integration test untuk sukses dan gagal.
```

---

## Work Card

Path: `.workspace/work/F-<id>.md`. Satu file menggabungkan requirement detail dan task aktif. File boleh dihapus setelah requirement approved sudah tersalin ke SRS dan seluruh task selesai.

```markdown
---
id: F-01
version: 1.0.0
status: draft
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---

# F-01 — <Feature Name>

## Problem
<masalah user>

## Solution
<solusi dan batas scope>

## User Stories
- (MUST) As a <role>, I want <goal>, so that <benefit>.

## Acceptance Criteria
- AC-01: WHEN <trigger> THEN sistem SHALL <hasil terukur>.

## Implementation Decisions
- **Final:** <keputusan yang sudah disepakati>
- **Open:** <keputusan yang belum final>

## Prototype Decision (optional)
- **Question:** <satu pertanyaan desain/logic>
- **Status:** validated | inconclusive | rejected
- **Decision:** <keputusan dan risiko terbuka>

## Testing Decisions
- **Boundary:** <boundary publik>
- **Strategy:** <unit/integration/e2e>

## Tasks
- [ ] TASK-01 | <judul> | Depends: none | Priority: high | Parallel: no
    Detail: <behavior end-to-end>
    Ref: AC-01
    Done:
    - [ ] <kriteria terukur>
    - [ ] <cara verifikasi>

## Evidence
- <test, commit, atau catatan validasi>
```

---

### Example: first feature — `.workspace/work/F-01.md`

```markdown
---
id: F-01
version: 1.0.0
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
source: to-requirements
status: approved
---

# F-01 — Login OAuth

## Problem
User membutuhkan login yang aman tanpa mengelola password aplikasi secara langsung.

## Solution
Sistem menyediakan login OAuth dan membuat sesi setelah provider mengonfirmasi identitas user.

## Acceptance Criteria
- AC-01: WHEN OAuth berhasil THEN sistem SHALL membuat sesi user.
- AC-02: IF OAuth gagal THEN sistem SHALL menampilkan error yang dapat dipahami.

## Tasks
### Queue
- [ ] TASK-01 | Implement OAuth login | Depends: none | Priority: high | Parallel: no
    Detail: User dapat menyelesaikan login OAuth dan kembali ke aplikasi.
    Ref: AC-01, AC-02
    Done:
    - [ ] Test sukses dan gagal pass.
    - [ ] Error OAuth terlihat tanpa membocorkan credential.

## Evidence
- <test atau commit>
```

Contoh ini hanya dokumentasi; `setup-workflow` membuat work card kosong/lazy, bukan data fitur contoh.

---

## TRACKER.md

Path: `.workspace/context/TRACKER.md`

```yaml
# Feature execution progress. See `.workspace/context/SRS.md` for requirement lifecycle.
tracker: local
features:
  - id: F-01
    status: open          # open | done — semua task Done = done
    source: to-requirements | ask-me | manual
    created: <YYYY-MM-DD>
    updated: <YYYY-MM-DD>
    task_count: <total>
    task_done: <selesai>
```

Single-writer: `to-tasks` (buat entry), `implement` (counter). Task aktif dan detailnya disimpan di `.workspace/work/F-<id>.md`.

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
