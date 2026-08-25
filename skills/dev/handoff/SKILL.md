---
name: handoff
description: "Compact percakapan aktif jadi dokumen handoff untuk sesi/agent lain. Simpan di .workspace/handoffs/ (workspace), bukan temp directory OS. User-invoked."
disable-model-invocation: true
---

# Handoff

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — warning "tanpa setup, handoff tetap bisa disimpan di `.workspace/handoffs/`".

Beda dari "compact" bawaan agent — compact ringkas seluruh histori untuk lanjutkan thread sama. Handoff ambil **slice** konteks relevan buat task baru, sesi awal tetap utuh.

## Step 1 — Tulis Dokumen

Simpan ke `.workspace/handoffs/<timestamp>-<slug>.md` — dalam workspace, bukan temp OS. Bikin folder `.workspace/handoffs/` dulu kalau belum ada.

Nama file: timestamp (`YYYY-MM-DD`) + slug deskriptif singkat. **Timestamp = hari ini skill dipanggil** (bukan tanggal task/issue/commit/awal percakapan).

## Step 2 — Isi Dokumen

- Ringkasan progres saat ini
- Keputusan yang sudah dibuat
- Open question / next step
- **Wajib**: "Suggested Skills" — skill mana dari kumpulan dev yang harus dipanggil sesi berikutnya (`ask-me`, `implement`, `bug-diagnosis`, `improve-architecture`, `project-migration`, `to-prd`, `to-issues`, `code-review`, `handoff`)
- **Kalau sesi tengah `implement` belum sampai review**: sertakan spec/task detail relevan (behavior, interface, edge case dari grill, atau Detail task) — ringkas ke handoff biar sesi baru tidak perlu buka file lain.

## Aturan Reference-Only

Jangan duplikasi konten yang sudah ada di artifact lain (PRD, tasks.md, ADR, issue, commit, diff). Reference by path/URL — jangan copy isi.

**Kecuali**: snippet ringkas (<15 baris atau 1 paragraf pendek) krusial untuk agent berikutnya langsung jalan tanpa buka file lain (error trace, inti keputusan ADR baru, ringkasan hasil grill). Di atas itu → reference by path. Inline snippet pakai backtick/blockquote.

## Redaksi

[Redaction patterns](../shared/COMMON.md#redaction-patterns) — scan & redact sebelum tulis. Kalau ragu: tanya user "Ada info sensitif yang perlu diredact?"

## Step 3 — Tailor (Opsional)

User kasih argumen deskripsi fokus sesi berikutnya → sesuaikan isi dokumen ke fokus itu, bukan ringkasan generik.

## Kapan Pakai

- Sesi terlalu panjang, context window mendekati limit
- Side-quest (bug arsitektur saat kerja fitur) tanpa polusi konteks utama → handoff, buka sesi baru side-quest, balik ke sesi awal
- Ganti device/environment (Pi Agent → Antigravity)

## Saran Skills Lain

[Cross-ref](../shared/COMMON.md#saran-skills-lain) — Sesi pendek/jauh dari limit → lanjut biasa. Butuh compact ringkas thread sama → gunakan "compact" bawaan agent (bukan handoff).