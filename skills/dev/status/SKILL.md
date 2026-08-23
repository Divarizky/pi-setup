---
name: status
description: "Jawab \"gua lagi di mana?\" — baca state workflow lokal (feature aktif, task berjalan, handoff terakhir), ringkas jadi snapshot + saran skill berikutnya. Read-only, tidak menulis apapun. User-invoked."
disable-model-invocation: true
---

# Status

Snapshot cepat state kerja saat ini. Pas buka sesi baru dan lupa lagi ngerjain apa. Read-only — cuma baca + ringkas, tidak ubah file apapun.

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — `.workspace/project-meta.md` opsional. Universal mode bersifat read-only dan chat-only: buat snapshot dari percakapan aktif, current directory, Git bila tersedia, dan file workflow yang user berikan. Project-aware mode membaca state `.workspace` yang tersedia. Jika tidak ada state, laporkan bahwa belum ada pekerjaan yang bisa diringkas; tawarkan `setup-workflow` hanya jika user ingin persistence.

## Step 1 — Baca State (3 sumber, skip yang tidak ada/corrupt)

### Universal mode
Gunakan percakapan aktif, current directory, Git bila tersedia, dan file workflow yang user berikan. Jangan mengasumsikan tracker, tasks, atau handoff `.workspace` tersedia; jangan membuat file.

### Project-aware mode
Gunakan Context Resolver dan baca sumber berikut hanya jika tersedia:

### 1. Index Fitur
Baca `.workspace/tracking/issue-tracker.md`:
- Filter `status: open` dan `status: done`
- Ambil `task_count` + `task_done` untuk progress bar Step 2
- Tidak ada/format invalid → laporkan: "issue-tracker.md tidak terbaca. Tawarkan `setup-workflow` untuk memperbaiki persistence."

### 2. Task Aktif
Untuk slug `open` di index:
- Cek folder `.workspace/.scratch/<slug>/` ada? Tidak → laporkan: "Slug `<slug>`: folder `.scratch/<slug>/` hilang." Skip.
- Baca `.workspace/.scratch/<slug>/tasks.md` (format: `## Queue`/`## In Progress`/`## Done`, checkbox `[ ]`/`[x]`)

Ekstrak:
- **In Progress**: semua `[ ]` di bawah `## In Progress` → TASK-ID + nama
- **Queue eligible**: di `## Queue`, `[ ]` yang `Depends:` sudah `[x]` di `## Done` → task teratas
- **Queue count**: total `[ ]` di `## Queue`

File tidak ada tapi index bilang `open` → laporkan: "Slug X: tasks.md tidak ditemukan."
File ada tapi format tidak parse → laporkan: "Slug X: tasks.md format tidak dikenal."

### 3. Handoff Terakhir
Project-aware: cari file terbaru di `.workspace/handoffs/` — `ls -t .workspace/handoffs/*.md 2>/dev/null | head -1` (sort by mtime, bukan string filename).
Universal: gunakan handoff yang ditempelkan atau dirujuk user.
Ambil 1 baris ringkasan (biasanya baris pertama setelah judul). Jangan baca seluruh file.
Folder tidak ada/kosong → skip.

## Step 2 — Ringkas

```
## Status

**Feature aktif:**
- <slug> (<task_done>/<task_count> task selesai) — <status>
  (atau "tidak ada feature open")

**Sedang dikerjakan:**
- TASK-N | <nama task> | <slug>
  (atau "tidak ada")

**Queue antrian:** <N> task — task teratas eligible:
- TASK-M | <nama task> | <slug>
  (atau "-")

**Handoff terakhir:** <path> — <1 baris ringkas>
  (atau "tidak ada")

**Feature done:** <slug(s)> — atau "tidak ada"
```

Jangan dump seluruh isi tasks.md/handoff — cukup baris relevan. Reference by path kalau user mau detail.

### Stale Task Detection
Cek task In Progress tanpa aktivitas:
- Bukan git repo (`git rev-parse --git-dir 2>/dev/null` gagal) → "tidak bisa deteksi staleness (bukan git repo)"
- Git repo: `git log --since="7 days ago" --all --oneline` — ada output = ada commit 7 hari terakhir. Atau `git log -1 --format="%ar" HEAD` → "3 hours ago", "2 weeks ago".
- Tampilkan: "TASK-N — last commit: <N hari> lalu — <slug>."

### Stale Features
Cek `issue-tracker.md` fitur `status: done` dengan `updated` >30 hari lalu → tampilkan: "<slug> — done sejak <tanggal>. Masih di `.scratch/`."

## Step 3 — Saran Skill Berikutnya

Berdasarkan state, sarankan (user putuskan, bukan auto-invoke):

- Ada task In Progress / Queue eligible → `implement`
- Tidak ada feature open, mau mulai fitur baru → `ask-me` (grill dulu) atau `to-prd` langsung kalau ide sudah jelas
- Handoff terakhir punya "Suggested Skills" → tampilkan saran itu
- Semua feature `done`, tidak ada kerja tertunda → beri tahu, saran `improve-architecture` (health check) opsional
- Queue penuh tapi semua blocked → "Semua task nunggu dependency. Kerjakan blocker dulu via `implement`."

## Saran Skills Lain

[Workflow](../WORKFLOW.md) — Awal sesi baru, setelah break panjang, ragu task tertunda, sebelum invoke `implement`.