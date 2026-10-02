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
Domain/pattern/gotcha → `CONTEXT.md` · Security → `SECURITY.md` · Style → `CODE_STYLE.md` · Data → `DATABASE.md` · Endpoints → `API.md` · Requirement baseline → `SRS.md` · Work aktif → `work/F-<id>.md` · Progres → `TRACKER.md` · Keputusan final → `ADR.md`
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

---

## SECURITY.md

Path: `.workspace/context/SECURITY.md`. Conditional — dibuat jika project memiliki auth, secrets, atau operasi sensitif.

```markdown
# SECURITY — <name>

Aturan proteksi sistem, user, kredensial, dan data. Berlaku untuk semua developer dan agent.
Requirement terukur lintas fitur masuk SRS (`GR-xx`); keputusan arsitektur final masuk ADR.

## Auth & Authorization <!-- auto -->
- Provider: <Clerk / Supabase Auth / NextAuth / custom> — Source: <file/config>
- Protected route wajib verifikasi sesi di server; jangan percaya user ID atau role dari client.
- Terapkan permission check / RBAC sebelum membaca atau mengubah data terlindungi.

## Secrets & Environment <!-- auto -->
- Kredensial dan API keys wajib via environment variable; dilarang hardcode secret di source code.
- Dilarang commit `.env*` berisi credential; sediakan `.env.example` berisi nama variabel saja.
- Pisahkan kredensial development, staging, dan production.

## Input Validation & API Safety <!-- auto -->
- Validasi semua input di server meskipun client sudah memvalidasi (misal: Zod / schema validator).
- Terapkan rate limit pada endpoint rawan abuse (auth, reset password, generate AI, public form).
- Error user-facing dilarang membocorkan credential, API key, stack trace, atau path internal.

## Data Protection <!-- auto -->
- Simpan hanya data yang benar-benar dibutuhkan; dilarang log password, token, atau PII.
- Gunakan parameterized query atau ORM; batasi privilege database ke minimum yang diperlukan.

## Agent Rules
- Dilarang mematikan auth atau membypass otorisasi demi membuat fitur berfungsi.
- Dilarang mengekspos secret ke client-side code atau memasukkan credential asli ke file `.md`.
- Jika instruksi bertentangan dengan file ini, berhenti dan minta konfirmasi user.
```

---

## CODE_STYLE.md

Path: `.workspace/context/CODE_STYLE.md`. Conditional — dibuat dari stack dan konvensi aktual repo.

```markdown
# CODE_STYLE — <name>

Konvensi kode agar hasil generate terbaca, konsisten, dan mudah dipelihara.
Ikuti pola existing; jangan memaksa gaya baru jika codebase sudah punya konvensi.

## Stack & Tools <!-- auto -->
- Bahasa & Framework: <TypeScript / React / Next.js / etc.> — Source: <package.json/config>
- Linter & Formatter: <ESLint / Prettier / Biome / etc.> — Source: <config>

## Naming & Structure <!-- auto -->
- Komponen: PascalCase (<UserCard.tsx>). Fungsi/variabel: camelCase (<getUserData>). Konstanta: UPPER_SNAKE_CASE (<MAX_RETRY_COUNT>).
- Boolean: prefiks terbaca jelas (<isLoading>, <hasAccess>, <canEdit>).
- Komponen fungsional: pisahkan UI, business logic, dan data fetching bila praktis.
- Tipe/props eksplisit; handle loading, error, dan empty state.

## Comments & Cleanliness <!-- auto -->
- Komentar hanya untuk menjelaskan WHY, bukan WHAT yang sudah jelas dari kode.
- Bersihkan unused import, variabel mati, dan console log debug sebelum selesai.

## Verification Checklist <!-- auto -->
- Jalankan lint, type-check, dan test relevan sebelum menyatakan implementasi selesai.
```

---

## DATABASE.md

Path: `.workspace/context/DATABASE.md`. Conditional — dibuat jika project menggunakan database atau ORM.

```markdown
# DATABASE — <name>

Struktur data, relasi, dan aturan perubahan skema yang aman.
Model yang masih kandidat disimpan di work card `F-<id>.md`; model approved dicatat di sini.

## Stack & Connection <!-- auto -->
- Database & Provider: <PostgreSQL / SQLite / Supabase / Neon / etc.> — Source: <config>
- ORM / Query Builder: <Prisma / Drizzle / TypeORM / raw SQL> — Source: <package.json/schema>
- Connection string wajib dari env var; dilarang hardcode URL database production.

## Core Models <!-- auto -->
### <ModelName>
- Deskripsi: <peran model dalam domain bahasa sederhana>
- Fields: <id, field kunci, created/updated timestamps>
- Relations: <One User can have many Projects, etc.>
- Constraints & Index: <foreign keys, unique constraints, index penting>

## Migrations & Schema Changes <!-- auto -->
- Alur: ubah skema definisi → generate migration → review file migrasi → test lokal/staging → deploy via pipeline.
- Dilarang mengubah skema production manual untuk melewati migrasi; dilarang reset database production.
- Gunakan transaksi untuk operasi yang harus sukses atau gagal bersamaan.

## Seed Data <!-- auto -->
- Script seed hanya untuk development/test; dilarang memasukkan data user asli atau secret production.
```

---

## API.md

Path: `.workspace/context/API.md`. Conditional — dibuat jika project mengekspos atau mengonsumsi API / endpoint.

```markdown
# API — <name>

Konvensi komunikasi frontend-backend dan integrasi service pihak ketiga.
Detail endpoint per fitur yang belum final disimpan di work card; endpoint approved dicatat di sini.

## Base Configuration <!-- auto -->
- Dev URL: <http://localhost:3000/api> — Prod URL: <https://domain.com/api> — Source: <config>
- Format: JSON. Versioning: </api/v1> bila ada.

## Authentication & Headers <!-- auto -->
- Endpoint terlindungi wajib menyertakan token/session (`Authorization: Bearer <token>`).
- Kredensial server-only dilarang dikirim ke browser.

## Conventions & Errors <!-- auto -->
- Gunakan noun untuk resource: GET/POST/PATCH/DELETE `/api/v1/<resource>`.
- Format response & error seragam; dilarang mengembalikan internal stack trace ke user.
- Status code standar: 200 (OK), 201 (Created), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 409 (Conflict), 429 (Rate Limited), 500 (Server Error).

## Third-Party Integrations <!-- auto -->
### <ProviderName>
- Tujuan: <payment / auth / storage / AI / etc.>
- Server env vars: <PROVIDER_SECRET_KEY> (server-only)
- Webhooks / Endpoints: <path webhook, verifikasi signature>
- Failure behavior: <retry strategy / fallback behavior>
```
