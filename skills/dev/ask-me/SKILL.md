---
name: ask-me
description: "Jalur utama + grill. Auto-trigger saat user bilang: \"gimana caranya\", \"mau nambah X\", \"bantu aku Y\", \"lanjutin kerjaan\", atau intent ambigu. Route ke skill tepat berdasarkan Step 1 table. Untuk fitur baru, grill 3-5 pertanyaan dulu sebelum routing. Jangan trigger kalau user sudah sebut skill eksplisit."
model-invocation: enabled
---

# Ask Me

Router atas semua skill dev. Untuk fitur baru — grill dulu, lalu arahkan ke skill yang tepat.

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — izinkan lanjut dengan warning, jangan hard-stop.
Pengecualian: `implement`, `to-prd`, `to-issues` → hard-check, arahkan ke setup, stop.

## Jalur Utama

1. **Grill** (Step 2) — 3-5 pertanyaan → scope, behavior, terminologi
2. **Build** — `implement` (langsung untuk kecil, via `to-prd`→`to-issues` untuk besar)

### Off-ramps
- Bug → `bug-diagnosis`
- Arsitektur → `improve-architecture` (catat, jangan perbaiki sekarang)
- Sesi panjang → `handoff`
- Migrasi project → `project-migration`
- Desain ragu → `prototype`

## Step 1 — Deteksi Intent

| Sinyal | Jalur |
|--------|-------|
| "tambah fitur baru", "buat halaman baru", "mau bikin X" — no breakdown | → **Step 2 (Grill)** |
| "kerjakan task X", "lanjut task berikutnya", "implement task dari tasks.md" | `implement` |
| "error", "bug", "crash", "gagal", "lambat", stack trace | `bug-diagnosis` |
| "buat PRD", "dokumentasikan fitur ini", "tulis spec" | `to-prd` |
| "pecah jadi task", "breakdown plan ini", "buat daftar task" | `to-issues` |
| "refactor", "kode susah dibaca", "modul berantakan" (same project) | `improve-architecture` |
| "migrasi", "pindah project lama", "port ke project baru" | `project-migration` |
| "review perubahan ini", "cek diff sejak X", "vet sebelum commit" | `code-review` |
| "handoff", "compact sesi ini", "lanjut di sesi lain" | `handoff` |
| "gua lagi di mana", "status", "lagi ngerjain apa" | `status` |
| "coba explore", "test ide", "spike", "prototype", "ragu desain" | `prototype` (tanya: logic/state atau visual/layout?) |
| Ambigu, >1 skill match | Tanya user, tampilkan 2-3 opsi |
| `.workspace/` tidak ada | Tawarkan `setup-workflow` + warning |

Result ≠ "→ Step 2 (Grill)" → Step 3 (Konfirmasi), skip Step 2.

## Step 2 — Grill (khusus fitur baru)

Baca `AGENT.md` (quick) + `CONTEXT.md` (detail kalau perlu) + `ADR.md` dulu. Tanya satu per satu, skip yang jelas:

1. **Behavior** — "Apa yang harus terjadi dari sisi user?"
2. **Terminologi** — "Istilah baru atau sinonim existing?" — validasi vs AGENT.md
3. **Scope** — "Satu modul atau lintas modul?"
4. **Constraint** — "Batasan teknis/bisnis?"
5. **Priority** — "MUST (critical path) atau NICE?"

Istilah baru → update file inline (ikuti **Aturan Split** di `setup-workflow`): definisi ≤ 1 baris → `AGENT.md` `## <Istilah> — <definisi>`; penjelasan panjang / edge case / sinonim detail → `CONTEXT.md`. Bentrok → klarifikasi sinonim.

### Grill Dalam (scope besar / ambigu / new project)

**Mode Sharpen** (existing project, scope besar/ambigu):
1. Domain model — "Istilah kunci? Bentrok AGENT.md?"
2. Keputusan arsitektur — "Hard to reverse?" → ADR kalau lolos 3 filter
3. Validasi kode — "Klaim cocok kode existing?" → eksplorasi codebase
4. Dependency — "Bergantung ke apa? Ada seam?"
5. Test — "Punya test? Butuh characterization test?"

**Mode Bangun Domain** (new project, dari `setup-workflow`):
- Interview loop: 1 pertanyaan/giliran, rekomendasi jawaban
- **Max 15 pertanyaan** → tanya "Lanjut? (y/n)"
- Fokus: terminology inti, konsep, hubungan entitas, batasan sistem
- Output: AGENT.md (quick) + CONTEXT.md (detail) + ADR pertama — ikuti **Aturan Split**
- `--no-context` (dari `setup-workflow`) → semua ke AGENT.md saja

Aturan kedua mode: update AGENT.md/CONTEXT.md inline (ikuti **Aturan Split**), eksplorasi codebase dulu kalau bisa jawab.

### Tentukan Jalur

| Scope | Rekomendasi |
|-------|-------------|
| Kecil (1 modul), behavior jelas | `implement` langsung |
| Besar (lintas modul) | Grill dalam → `to-prd` → `to-issues` |
| Banyak ambigu / desain belum solid | Grill dalam → `prototype` |
| State machine / logic complex | `prototype` LOGIC |
| UI layout belum decided | `prototype` UI |

## Step 3 — Konfirmasi

"Ini masuk kategori [skill/rekomendasi], lanjut?" — user konfirmasi/koreksi.

## Step 4 — Redirect

Arahkan ke skill terpilih: "Ini masuk `implement`, lanjut di sana."

## Catatan

**Multi-Agent**: `.workspace/project-meta.md` persist across agents. `ask-me` di agent baru detect marker, no re-run `setup-workflow`.

## Tips

- User sebut skill eksplisit → invoke langsung, skip `ask-me`
- Cek setup sebelum route, tawarkan `setup-workflow` + warning

## Aturan Sesi

| Jenis | Aturan |
|-------|--------|
| Single-session | Grill + implement kecil selesai 1 sesi |
| Multi-session | Grill dalam + to-prd + to-issues: 1 sesi, no compact tengah; handoff sebelum tutup; implement per task di sesi fresh |
| Bug di tengah feature | 1. handoff feature context 2. bug-diagnosis terpisah 3. handoff fix 4. balik ke feature |
| Compact vs Handoff | Normal → lanjut; Thread sama penuh → compact; Ganti task/phase → handoff; Tengah phase → handoff (no compact) |

## Guard Auto-Trigger

`model-invocation: enabled`. Rules:
- User sebut skill eksplisit → no trigger
- Sinyal match skill spesifik → biarkan skill itu ambil
- Sinyal umum/ambigu → `ask-me` ambil