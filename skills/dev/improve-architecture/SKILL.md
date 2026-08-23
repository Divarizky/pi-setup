---
name: improve-architecture
description: "Scan modul shallow (interface lebar) yang bisa di-deepen (interface kecil, behavior besar di baliknya). Filter pakai deletion test, presentasi laporan teks, lalu interview kandidat. Manual invoke, periodic health check. Trigger: \"refactor\", \"kode ini susah dibaca\", \"modul ini berantakan\"."
disable-model-invocation: true
---

# Improve Architecture

## What It Does

Scan codebase, cari **deepening opportunities** — modul shallow (interface hampir sekompleks implementasi) bisa jadi deep. Presentasi laporan teks terstruktur, lalu grill kandidat yang dipilih.

Tidak kasih daftar refactor generik. Tiap kandidat lolos **deletion test** — hapus modul → kompleksitas terkonsentrasi (interface lebih kecil) atau cuma pindah? Hanya "terkonsentrasi" yang masuk laporan.

## When to Reach For It

Manual invoke only. Health check periodik: tiap beberapa hari, atau codebase terasa perlu lompat antar banyak modul untuk paham satu konsep.

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — `.workspace/project-meta.md` opsional. Gunakan Context Resolver; tanpa setup, Universal mode tetap berjalan dengan analisis terbatas dan tanpa artifact workflow.

## Deepening Opportunities

Inti: **depth**. Modul deep sembunyikan banyak fungsi di balik interface kecil & stabil. Modul shallow bocorkan implementasi lewat interface selebar kode di baliknya.

Cari tanda shallow (lihat [VOCABULARY](../shared/VOCABULARY.md#arsitektur)):
- Pure function diekstrak cuma demi testability, padahal bug asli di cara dipanggil (locality hilang)
- Modul bocor lintas seam
- Konsep butuh buka banyak file buat dipahami

Kandidat pakai istilah domain dari `AGENT.md` (+ `CONTEXT.md` untuk detail) jika tersedia: "Deepen the Order intake module", bukan "refactor FooBarHandler". Jika tidak tersedia, gunakan istilah yang terlihat dari source code dan nyatakan keterbatasannya.

## Laporan, Lalu Interview

Output: laporan teks. Tiap kandidat: file terkait, friksi, solusi plain-English, manfaat (locality/leverage), rating Strong/Worth Exploring/Speculative.

```markdown
## Architecture Improvement Report

**Rekomendasi Prioritas:** 1. Deepen <Nama Modul> (Strong)

### Kandidat 1: <Nama Modul>
**Files:** <file1>, <file2>, <file3>
**Masalah:** <1-2 kalimat>
**Solusi:** <deepening yang diusulkan>
**Manfaat:**
- <manfaat 1>
- <manfaat 2>
**Rating:** Strong | Worth Exploring | Speculative
```

**Rating Strong** = lolos deletion test (concentrates).

Klasifikasi dependency (dasar solusi):

| Tipe dependency | Cara handle |
|---|---|
| Pure computation, in-memory | Selalu bisa dideepen, gabung modul |
| Ada local test stand-in | Bisa dideepen, test pakai stand-in |
| Internal service lintas network | Definisikan port, transport di-inject sebagai adapter |
| Third-party service | Terima sebagai injected port, test pakai mock adapter |

**Seam rule**: jangan buat seam kecuali ada yang benar-benar bervariasi. 1 adapter = hipotetis. 2 adapter = nyata.

Gunakan Context Resolver dan baca `.workspace/context/ADR.md` hanya jika tersedia — jangan re-litigasi keputusan lama. Munculkan konflik ADR cuma kalau friksi nyata cukup dipertimbangkan ulang.

Setelah laporan → berhenti, tanya kandidat mana mau di-interview. User pilih satu → interview: constraint, apa di balik seam, test apa yang bertahan. Project-aware mode: update `.workspace/context/AGENT.md` inline jika modul dinamai konsep baru. Universal mode: tampilkan definisi/keputusan di chat, jangan menulis context artifact. Tawarkan ADR kalau user tolak kandidat dengan alasan load-bearing.

**Escape hatch**: interview >8 pertanyaan masih bergulir → sarankan `handoff` ke sesi baru. Jangan paksa selesai 1 sesi.

**Opsional**: kandidat signifikan → tawarkan eksplorasi beberapa desain interface berbeda paralel (minimalist, flexible, ports & adapters), rekomendasikan yang terkuat.

## Where It Fits

**Periodic maintenance** — tiap beberapa hari, bukan step dalam chain.

Kombinasi relevan:
- `bug-diagnosis` — temuan arsitektur saat debug jadi kandidat
- `code-review` — temuan arsitektur saat review, lanjut ke sini
- `implement` — cek deepening dulu sebelum implementasi area kompleks
- `project-migration` — health check sebelum migrasi