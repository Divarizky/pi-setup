---
name: to-tasks
description: "Pecah requirements/plan jadi task vertical-slice dengan traceability Ref ke AC. Dipanggil oleh user atau route workflow. Jangan gunakan kalau belum ada input jelas; tanyakan apakah perlu requirements dulu atau breakdown dari percakapan."
disable-model-invocation: true
---

# To Tasks

Pecah spec jadi task vertical-slice. Project mode menyimpan ke `tasks.md`; Universal mode menampilkan checklist di chat. Input: requirements, percakapan, atau split task existing.

## Invocation

Dipanggil eksplisit atau melalui route `ask-me`: "pecah jadi task", "breakdown plan ini", "buat daftar task implementasi", "split task".

## Prerequisites

[Prerequisites](../shared/COMMON.md#prerequisites) — `.workspace/project-meta.md` opsional. Tanpa workspace, gunakan universal mode: input dari percakapan atau requirements yang user berikan; output hanya berupa checklist di chat dan status di respons.
Input dari requirements.md → pastikan `status: approved` di frontmatter. Masih `draft` → konfirmasi: "requirements ini masih draft. Lanjut breakdown anyway atau approve dulu?"

[Sub-Agent Detection](../shared/COMMON.md#sub-agent-detection) — cek sekali per sesi.

## Step 1 — Detect Input Source

### Source A: requirements.md (Project mode or user-provided path)

1. Project: baca `.workspace/.scratch/<slug>/requirements.md`. Universal: gunakan requirements yang ditempelkan/tersedia di percakapan. Ambil Problem, Acceptance Criteria, User Stories, dan Testing Decisions.
2. `status: draft` → tanya user: "requirements masih draft. Lanjut breakdown atau approve dulu?"
3. `status: approved` → Step 2

### Source B: Active Conversation (deep `ask-me` grill or direct discussion)

1. Filter: hanya keputusan disepakati eksplisit. Ide tentatif → skip atau Further Notes
2. Belum ada requirements.md → tanya: "Mau buat requirements dulu lewat `to-requirements`, atau langsung breakdown dari percakapan?"
3. User pilih langsung → ekstrak problem, solution, behavior → Step 2

### Source C: Split Existing Task

1. Project: baca `.workspace/.scratch/<slug>/tasks.md`. Universal: gunakan task/checklist yang user berikan di percakapan. Cari task di Queue dengan deskripsi >5 baris atau scope lebar.
2. Proposal: "TASK-3 terlalu besar. Pecah jadi sub-task?" User setuju → sub-task list.
3. Skip Step 2 (ini sub-division, bukan slice baru) → Step 3 dengan format khusus split.
4. Tidak ada task oversized → beri tahu user, stop

## Step 2 — Vertical Slices + Greenfield Branch

### Definition

- **Horizontal slice**: satu layer saja (schema, API, UI) — tidak bisa di-demo sampai semua layer selesai
- **Vertical slice** (tracer bullet): satu jalur sempit tembus SEMUA layer — bisa langsung di-demo

### Project Branching Status

Project mode: baca `.workspace/project-meta.md`.
Universal mode: tentukan existing/new dari current directory dan file yang terlihat; jika tidak jelas, tanyakan user.

**Existing** (`status: existing`):

- Eksplorasi codebase terfokus — 5 file atau 3 menit. Cari layer stack dari struktur folder
- Judul & deskripsi pakai vocabulary `PROJECT.md` (+ `CONTEXT.md` untuk detail), respect `ADR.md`

**New** (`status: new` / greenfield):

- Tidak perlu eksplorasi — belum ada kode
- Tentukan layer stack bareng user: "Project ini layer apa aja? Frontend web? Mobile? Backend API? Database? Infra?"
- Vertical slice tetap relevan — layer yang akan dibangun
- Prefactoring skip (tidak ada kode)

### Prefactoring (existing projects only)

Sebelum breakdown, cari 1-2 smell kecil di area langsung disentuh fitur. **Bukan refactor besar. Batas: maksimal 2 perubahan.**

- Rename method/variable (no behavior change)
- Extract function ≤10 baris dari method panjang
- Inline trivial wrapper (delegasi 1 baris ke target asli)
- **Dilarang**: restrukturisasi modul, ganti pola arsitektur, extract interface baru → `improve-architecture`
- Tanya user: "Saya lihat [smell] di area yang akan disentuh. Betulkan dulu sebelum breakdown? (1-2 perubahan kecil)"
- User skip → catat di Further Notes, jangan paksa

## Step 3 — Present and Iterate Breakdown

### Proposal Format

```
**Proposed Slices:**

**1. [Judul Slice]**
- Blocked by: None / TASK-xxx
- User stories covered: <MUST/SHOULD/NICE dari requirements, atau "N/A — split task">
- Ref: <nomor Acceptance Criteria / User Story dari requirements yang dicover slice ini, mis. "AC 1, 3" — N/A untuk split>
- Scope: <deskripsi singkat end-to-end behavior>
- Layers: <layer yang ditembus — frontend, backend, DB, infra>
- Uncertainty: low / medium / high (opsional — flag butuh research)
- Complexity: low / medium / high
- Parallel: yes | no (yes cuma kalau aman paralel — lihat aturan Step 4)
- Done:
  - <kriteria konkret pertama — kapan task ini selesai>
  - <kriteria konkret kedua — cara verifikasi selesai>
```

- **Layers check**: proposal cuma 1 layer? Flag: "Ini horizontal slice. Yakin pisah per layer, atau gabung jadi vertical?"
- **Demoable check**: "Setelah slice ini selesai, apa yang bisa di-demo/test?" Jawaban tidak ada → slice belum vertical.
- **Done criteria**: harus terukur. "Login berfungsi" ❌. "User login email+password, test e2e pass, error message invalid credential" ✅.

### Iteration

Minta user approve, merge (& gabung dependency), split (& pecah dependency), atau reorder. Iterasi sampai granularity & dependency disetujui.

### Overlap Check (parallel tasks)

Dua task `Parallel: yes` menyentuh layer/area sama → risiko konflik file. Gabung jadi satu task, atau ubah salah satunya `Parallel: no`.

### Cycle Detection

Setiap user setuju dependency chain → cek cycle (topological sort Kahn/DFS+back edge). Cycle terdeteksi → "TASK-1, TASK-3, TASK-5 cycle — tidak ada task yang bisa dimulai. Hapus/reorder salah satu dependency?" Lanjut Step 4 setelah cycle resolved.

## Step 4 — Show Breakdown Result

Project mode: tulis ke `.workspace/.scratch/<feature-slug>/tasks.md` dan update tracker.
Universal mode: jangan membuat atau memperbarui file. Tampilkan proposal/final checklist di chat dan catat status breakdown di respons:

```text
Status breakdown: proposed | approved
Task count: <jumlah>
Eligible berikutnya: <TASK-ID atau none>
Persistence: chat-only (Universal mode)
```

### Standard Format

```markdown
# <Feature Name> — Tasks

## Queue

- [ ] TASK-<nomor> | <Nama task> | Depends: <TASK-ID atau "none"> | Priority: critical|high|medium|low | Parallel: yes|no
      Detail: <end-to-end behavior, bukan implementasi per layer>
      Done:
  - [ ] <kriteria konkret pertama — terukur>
  - [ ] <kriteria konkret kedua — cara verifikasi selesai>

## In Progress

- [ ] TASK-<nomor> | <Nama task> | Depends: <TASK-ID atau "none"> | Priority: critical|high|medium|low | Parallel: yes|no
      (cut dari Queue, paste ke sini — checkbox tetap [ ])

## Done

- [x] TASK-<nomor> | <Nama task> | Depends: <TASK-ID atau "none"> | Priority: critical|high|medium|low | Parallel: yes|no
      (cut dari In Progress, ganti [ ] jadi [x])
```

Urutan `## Queue`: priority critical→high→medium→low. Sama level: unblocked (`Depends: none`) duluan. `## Done` append ke bawah tiap selesai.

### Format Rules

- **Depends**: koma + spasi (`TASK-1, TASK-2`). Tidak ada dependency: `none`
- **Priority**: huruf kecil semua — `critical|high|medium|low` (konsisten dengan proposal)
- **Parallel**: `yes|no` (default `no`). `yes` HANYA kalau SEMUA: `subagent_supported` true, `Depends: none` (atau semua dependency `[x]` di Done), scope/layers tidak overlap task eligible lain, bukan `Uncertainty: High`/`Complexity: High`. Agent tanpa subagent → wajib `no`. `Parallel` cuma penanda eksekusi paralel di `implement` — bukan pengganti dependency.
- **Nomor TASK**: sequential, lanjut dari nomor tertinggi existing; jika tidak ada task sebelumnya, mulai dari `TASK-1`
- **Detail**: 2-5 kalimat. Fokus behavior — apa yang harus muncul, bukan gimana implementasinya
- **Ref**: referensi AC/user story requirements yang dicover task (mis. `Ref: AC 1, 3`) — dipakai `code-review` axis Spec untuk cek coverage. Wajib untuk breakdown dari requirements; `none` untuk split task/percakapan tanpa AC
- **Coding-agent-only**: task hanya boleh tulis/ubah/test kode. Larang masuk plan: UAT manual, deployment, gathering metrik, training/dokumentasi bisnis, perubahan proses organisasi. Task non-coding yang terdeteksi → catat di Further Notes requirements, keluar dari tasks.md
- **Done criteria**: minimal 2. Bisa verifikasi tanpa buka kode (test pass, API response, screenshot)
- **Group heading**: `## Queue`/`## In Progress`/`## Done`/`## Superseded` — dipakai `implement` & `status` untuk navigasi
- **Pindah task**: `## Queue`→`## In Progress`: cut baris, paste ke bawah heading `## In Progress` (checkbox `[ ]`). `## In Progress`→`## Done`: cut, paste ke bawah heading `## Done` (append bawah), `[ ]`→`[x]`

### Pre-Writing Validation

- Setiap TASK-ID di `Depends:` beneran ada di file
- Priority value valid (`critical|high|medium|low`)
- `Parallel:` valid (`yes|no`)
- Tidak ada dependency cycle (re-check setelah finalisasi)
- Done criteria tidak ambigu (no "seharusnya", "kiranya", "work properly")

Invalid → tanya user, jangan tulis dulu.

### Backtrack to to-requirements

Spec bolong saat breakdown — AC ambigu, konflik antar kriteria, atau ada behavior tak terdefinisi — → stop, jangan nebak sendiri. Balik ke `to-requirements`: perbaiki requirements (bump version), approve ulang, baru lanjut breakdown dengan spec yang sehat.

### Split Existing Task

Task lama di-split → pindah ke `## Superseded`:

```markdown
## Superseded

- [ ] ~~TASK-3 | Setup Login Page | Depends: none | Priority: critical~~
      Superseded by: TASK-3a, TASK-3b
```

- Judul strikethrough, catat superseded-by
- Transfer dependency: task lain depends on TASK-3 → ganti ke TASK-3a. Beri tahu user.

### Update Index (Project Mode)

Hanya Project mode yang menulis atau memperbarui entry slug di `.workspace/context/TRACKER.md`:

```yaml
tracker: local
features:
  - slug: <feature-slug>
    status: open
    source: to-requirements | ask-me | manual
    created: <YYYY-MM-DD>
    updated: <YYYY-MM-DD>
    task_count: <total task>
    task_done: <task selesai — 0 pas baru dibuat>
```

Slug baru → tambahkan. Slug existing → update `updated`, `task_count`, `task_done`. Jangan overwrite `created` & `source`.

### Notes

- Hindari hard-coded file path/code snippet — cepat basi
- Behavior focus: deskripsi task fokus apa yang harus terjadi, bukan implementasi per layer
- State task ditentukan section heading, bukan checkbox. `[x]` cuma buat Done.

## Step 5 — Finalise and Chain

- Project: beri tahu user daftar task + path `tasks.md`.
- Universal: tampilkan daftar task, `Status breakdown`, `Task count`, `Eligible berikutnya`, dan `Persistence: chat-only`; tidak ada path artifact.
- Cek task tracker jika Project; Universal memakai checklist yang baru ditampilkan: ada task eligible (di Queue, Depends none atau semua sudah Done)?
  - **Ada**: tanya "Lanjut execute task pertama via `implement`? (y/n)". `y` → baca `implement/SKILL.md`, jalankan Step 1-5 manual (chain `to-requirements`→`to-tasks`). User bisa invoke `implement` langsung kapan saja.
  - **Tidak ada (semua blocked)**: "Semua task nunggu dependency. Selesaikan blocker dulu via `implement`."
- Slice Uncertainty High/butuh sharpen desain → flag: "TASK-4 butuh riset dulu — sarankan `ask-me` grill dalam, atau `prototype` (LOGIC/UI) kalau perlu validasi desain, sebelum eksekusi."

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Fitur sudah ada task → `implement`. Belum ada requirements jelas → `to-requirements` dulu. Task butuh sharpen → `ask-me` grill dalam. Uncertainty High → `prototype` dulu, answer captured baru breakdown real task.
