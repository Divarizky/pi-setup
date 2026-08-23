---
name: implement
description: "Eksekusi implementasi (TDD, chain ke code-review). Dipanggil eksplisit atau melalui route workflow. Jangan gunakan untuk bug sulit — gunakan bug-diagnosis."
disable-model-invocation: true
---

# Implement

Engine eksekusi. Input dari tasks.md (task existing) atau hasil grill/diskusi (fitur baru).

## Invocation

Dipanggil eksplisit atau melalui route `ask-me`: "kerjakan task X", "lanjut task berikutnya", "implement task dari tasks.md", "coding fitur ini", "mulai implementasi".

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — `.workspace/project-meta.md` opsional. Tanpa workspace, gunakan universal mode: context dari percakapan/current directory, tanpa membuat artifact workflow; catat status implementasi di respons.

[Subagent Detection](../shared/COMMON.md#subagent-detection) — cek sekali per sesi.

## Step 1 — Cari Input (prioritas)

1. **Konteks percakapan** — behavior jelas dari grill `ask-me` / diskusi → langsung Step 3 (TDD), skip Step 2.
2. **Task persisted** — cari `tasks.md` di path yang sudah disepakati atau `.workspace/.scratch/<slug>/tasks.md` jika Project-aware mode. Ambil task eligible di `## Queue` (Depends sudah `[x]` di `## Done`).
   - ≥2 task `Parallel: yes` → siapkan batch (maks 3) untuk Step 2b.
   - Lanjut Step 2.
3. **Tidak ada keduanya** — tanya: "Mau langsung implement dari instruksi ini, atau breakdown dulu lewat `to-issues`?" Dalam Universal mode, `to-issues` menghasilkan checklist di chat dan status breakdown di respons.

## Step 2 — Update Status (hanya jika task persisted)

Jika task berasal dari `tasks.md`, cut dari `## Queue` → paste ke `## In Progress`. Batch `Parallel: yes` → cut semua sekaligus.

Jika Universal mode memakai instruksi langsung atau checklist di chat, jangan membuat atau memperbarui `tasks.md` secara otomatis; cukup catat status di respons.

## Step 2b — Eksekusi Paralel (batch `Parallel: yes`)

Jalan kalau: batch eligible (≥2 task, semua `Parallel: yes` + dependency selesai) DAN `subagent_supported == true`.

1. Ambil maks **3** task (urutan priority)
2. Spawn subagent per task → jalankan **Step 3 (TDD) saja**. Brief: Detail + Done criteria, selalu baca aturan canonical `../shared/TDD.md`; baca gold standard/vocabulary tambahan jika tersedia. Instruksi:
   - **JANGAN** update `tasks.md` (single-writer: sesi utama)
   - **JANGAN** commit
   - **JANGAN** review
   - Laporkan: path file, test pass/fail, done criteria terpenuhi/tidak
3. **Fallback sequential**: `subagent_supported == false` → kerjakan batch satu per satu (Step 3 normal). `Parallel: yes` diabaikan.

### Error Handling Sub-Agent

Subagent gagal → jangan block batch. Lapor partial: "TASK-2: [error]". Task tetap `## In Progress`. Setelah batch selesai → task gagal dikerjakan ulang **sequential** (Step 3 normal). Info user.

## Step 3 — Implement (TDD)

**Selalu baca dan ikuti `../shared/TDD.md` sebelum menulis test atau kode.**
TDD canonical ini berlaku untuk Universal dan Project-aware mode. Gunakan context/spec project sebagai input tambahan saja.

Adjust by type:

- **Pure logic/compute** → TDD penuh, wajib test critical path + edge case
- **UI-heavy / API integration** → minimal 1 test critical path; TDD penuh boleh disederhanakan sesuai boundary behavior di canonical TDD
- **Bug fix** → characterization test dulu (tangkap behavior existing termasuk bug), baru fix + update assertion. **Jangan hapus test characterization** → jadi regression test
- **Greenfield / no test framework** → setup test runner dulu. Setup >10 menit → tunda full TDD, inform user dan tetap catat validasi yang dilakukan

### Step 3a — Gold Standard File (Pre-TDD)

Project-aware mode: jika `.workspace/context/AGENT.md` tersedia, baca frontmatter `style_reference_path`. Universal mode: cari file style reference hanya jika user memberi path atau project punya konvensi yang jelas; jangan membuat asumsi.

```python
agent_path = ".workspace/context/AGENT.md"
if file_exists(agent_path):
    context = parse_agent_md(read(agent_path))
    style_path = context.get("style_reference_path")
    if style_path and file_exists(style_path):
        gold_content = read(style_path)
        prepend_to_prompt(f"GOLD STANDARD FILE ({style_path}):\n{gold_content}\nIkuti gaya coding persis.")
```

### Escape Hatch

[Template](../shared/COMMON.md#escape-hatch) — max 3 siklus RED→GREEN gagal → tanya user: (a) skip test, (b) minta bantuan, (c) batalkan. Catat alasan kalau skip.

### Catatan Implementasi

- Gunakan vocabulary dari `AGENT.md`/`CONTEXT.md` bila tersedia, dan hormati `ADR.md` bila ada
- Test verifikasi behavior via interface publik, bukan detail implementasi
- Nemu code smell struktural → catat, jangan perbaiki. Sarankan `improve-architecture` nanti.

## Step 4 — Review

### Delegasikan ke `code-review`

Pass spec (tasks.md Detail+Done criteria atau grill behavior+terminologi) sebagai text inline. **Sertakan Done criteria**. `code-review` Step 1 tentukan fixed point.

`code-review` `disable-model-invocation: true` → **baca `code-review/SKILL.md`, jalankan Step 1-5 manual** di sesi yang sama.

### Kalau Eksekusi Paralel (Step 2b)

Review **SETELAH semua task batch selesai** — sekali untuk seluruh diff batch. Jangan review per-task di subagent. Task gagal subagent juga harus selesai (sequential) sebelum review.

## Step 5 — Selesai

**Review pass:**
- Jika task berasal dari `tasks.md`: cut `## In Progress` → `## Done` (append bawah), `[ ]`→`[x]`, lalu update index.
- Jika Universal mode memakai instruksi langsung: jangan membuat tracking otomatis; laporkan perubahan dan validasi di respons.
- Jika user sebelumnya memilih path checklist tertentu: update hanya artifact tersebut.
- Inform user task selesai
- **Cek `awaiting_style_reference`** — hanya dalam Project-aware mode, kalau `true` (project baru) dan task menghasilkan file substantif pertama (screen/service/repository/model):
  ```python
  prompt: "File substantif pertama selesai. Set sebagai gold standard?\nPath: <path>\n[y/N/custom]: "
  if confirmed: context["style_reference_path"]=path; context["awaiting_style_reference"]=false; write_context()
  ```
- Tanya: "Selesai. Mau commit dulu atau lanjut?" (no auto-commit)
- Jika `tasks.md` tersedia: cek `## Queue` — task eligible (dependency `[x]`)? Tawarkan: "TASK-N eligible. Kerjakan? (y/n)". `y` → ulang Step 2.
- Jika Project-aware mode dan `task_done == task_count`: tanya apakah `.scratch/<slug>/` perlu diarsipkan.

**Review ada temuan:**
- Task tetap `## In Progress`
- No commit suggestion
- Balik Step 3, perbaiki, ulang Step 4
- Batch paralel: temuan diidentifikasi per task → task terlibat kembali Step 3; lain lanjut. Temuan menyebar tak jelas → semua batch kembali Step 3 sequential.

### Update Index (Project-aware mode)

Jika task berasal dari `.workspace/.scratch/<slug>/tasks.md`, update `.workspace/tracking/issue-tracker.md`: increment `task_done`, cek `task_done==task_count` → `status: done`, update `updated: <today>`. Universal mode tidak membuat index otomatis.

### Tracking Minimal (opsional)

Hanya jalankan dalam Project-aware mode. Universal mode tidak membuat tracking artifact; laporkan status implementasi, test, dan done criteria di respons. Dalam Project-aware mode, tulis entry ke `.workspace/tracking/issue-tracker.md` dan `.workspace/.scratch/<slug>/tasks.md`:
```yaml
# issue-tracker.md
- slug: <fitur>
  status: done
  source: ask-me
  created: <today>
  updated: <today>
  task_count: 1
  task_done: 1
```
```markdown
# <Fitur> — Tasks
## Done
- [x] TASK-1 | <judul> | Depends: none | Priority: medium
    Detail: <behavior dari grill>
    Done:
    - [x] <criteria>
```

### Aturan Commit

- Task persisted: commit hanya setelah implementasi utuh masuk `## Done`, bukan tengah TDD.
- Universal mode/instruksi langsung: commit setelah implementasi dan review selesai, jika user meminta commit.
- Prefactoring commit terpisah dari implementasi — jangan digabung.

### Side Quest — Code Smell

Nemu arsitektur signifikan (tidak terkait task) → catat: path, deskripsi, saran. Setelah Step 5: "Saya lihat potensi deepening di [modul]. Kapan-kapan invoke `improve-architecture`."

## Saran Skills Lain

[Workflow](../WORKFLOW.md) — Task belum breakdown → `to-issues`. Butuh domain modeling → `ask-me` grill dalam. Temuan arsitektur → `improve-architecture` terpisah. Sesi tutup task In Progress → `handoff` dulu.

## Chain

`to-prd`→`to-issues`→`implement`→`code-review`. Setelah `code-review`:
- Pass → kembali Step 5 `implement`
- Fail → kembali Step 3 `implement` (perbaiki, review ulang)
