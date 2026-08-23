---
name: handoff
description: "Compact percakapan aktif jadi ringkasan handoff untuk sesi/agent lain. Project-aware menyimpan dokumen; Universal menampilkan handoff di chat. User-invoked."
disable-model-invocation: true
---

# Handoff

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — tanpa workspace, Universal mode menampilkan ringkasan handoff dan Suggested Skills di respons; tidak membuat file.

Beda dari "compact" bawaan agent — compact ringkas seluruh histori untuk lanjutkan thread sama. Handoff ambil **slice** konteks relevan buat task baru, sesi awal tetap utuh.

## Step 1 — Tulis atau Salin Handoff

Project-aware mode: simpan ke `.workspace/handoffs/<timestamp>-<slug>.md`.
Universal mode: susun handoff lengkap, redaksi secret, lalu salin ke system clipboard. Jangan membuat file. Di chat, tampilkan hanya ringkasan singkat, Suggested Skills, dan next step.

Jika clipboard tidak tersedia atau gagal ditulis, laporkan kegagalan dan minta konfirmasi sebelum menampilkan handoff lengkap di chat.

Nama file: timestamp (`YYYY-MM-DD`) + slug deskriptif singkat. **Timestamp = hari ini skill dipanggil** (bukan tanggal task/issue/commit/awal percakapan).

## Step 2 — Isi Handoff

Isi berikut berlaku untuk dokumen Project-aware maupun ringkasan chat Universal:

- Ringkasan progres saat ini
- Keputusan yang sudah dibuat
- Open question / next step
- **Wajib**: "Suggested Skills" — skill mana dari kumpulan dev yang harus dipanggil sesi berikutnya (`ask-me`, `implement`, `bug-diagnosis`, `improve-architecture`, `project-migration`, `to-prd`, `to-issues`, `code-review`, `prototype`, `status`, `setup-workflow`, `handoff`)
- **Kalau sesi tengah `implement` belum sampai review**: sertakan spec/task detail relevan (behavior, interface, edge case dari grill, atau Detail task) — ringkas ke handoff biar sesi baru tidak perlu buka file lain.

## Aturan Reference-Only

Project-aware: jangan duplikasi konten yang sudah ada di artifact lain (PRD, tasks.md, ADR, issue, commit, diff). Reference by path/URL — jangan copy isi.

Universal: handoff lengkap disimpan di clipboard, bukan artifact file. Ringkasan chat cukup memuat progres, keputusan utama, open question, Suggested Skills, dan next step. Jika sumber hanya tersedia lewat path, sebutkan path tersebut tanpa menganggap file akan tersedia di sesi berikutnya.

**Kecuali**: snippet ringkas (<15 baris atau 1 paragraf pendek) krusial untuk agent berikutnya langsung jalan tanpa buka file lain (error trace, inti keputusan ADR baru, ringkasan hasil grill). Di atas itu → reference by path. Inline snippet pakai backtick/blockquote.

## Redaksi

[Redaction patterns](../shared/COMMON.md#redaction-patterns) — scan & redact sebelum tulis. Kalau ragu: tanya user "Ada info sensitif yang perlu diredact?"

## Status Universal

Universal mode selalu tampilkan ringkasan dan status clipboard:

```text
Mode: Universal
Full Handoff: copied-to-clipboard | clipboard-failed
Chat Output: summary-only
Status: handoff-ready | clipboard-failed
Suggested Skills: <daftar>
Next Step: <aksi berikutnya>
```

Jangan menampilkan isi penuh handoff di chat kecuali clipboard gagal dan user menyetujuinya.

## Step 3 — Tailor (Opsional)

User kasih argumen deskripsi fokus sesi berikutnya → sesuaikan isi dokumen ke fokus itu, bukan ringkasan generik.

## Kapan Pakai

- Sesi terlalu panjang, context window mendekati limit
- Side-quest (bug arsitektur saat kerja fitur) tanpa polusi konteks utama → handoff, buka sesi baru side-quest, balik ke sesi awal
- Ganti device/environment (Pi Agent → Antigravity)

## Saran Skills Lain

[Workflow](../WORKFLOW.md) — Sesi pendek/jauh dari limit → lanjut biasa. Butuh compact ringkas thread sama → gunakan "compact" bawaan agent (bukan handoff).