---
description: Kelola vault memory (save/check/audit) — safety bertingkat by risiko
argument-hint: "<save|check|audit> [catatan]"
---

## Memory Protocol

Subcommand: `${1:-none}`. Jika `none` atau tidak dikenal, tampilkan daftar subcommand dan berhenti tanpa perubahan.

Catatan user: `${@:2}`

### Safety Bertingkat

- **Aman (langsung jalan):** tulis/append `daily/`, tambah ADR ke `decisions.md`, tambah insight ke `learnings.md`/`knowledge/`, backfill backlink pada file disentuh.
- **Bahaya (wajib preview + konfirmasi eksplisit):** hapus file/section, pindah/merge ke `summaries/`, hapus folder project. Tanpa konfirmasi = tanpa eksekusi.

### save — Finalisasi Sesi (non-destruktif)

1. Baca recap durable hari ini dari `inbox/YYYY-MM-DD/` + keputusan percakapan berjalan. Jangan ringkas ulang dari nol.
2. Tulis/update `daily/YYYY-MM-DD.md` (WIB). WAJIB `## TL;DR` paling atas:

```markdown
# YYYY-MM-DD — Day

## TL;DR

- [keputusan penting / fix utama]
- [blocker atau "none"]

## Activity

- [yang dikerjain sesi ini]

## Notes

- [observasi, keputusan kecil, konteks]

## Blockers

- [masalah belum selesai, atau "none"]

## Links

- [[knowledge/file-yang-disentuh]]
- [[projects/slug/file-project]]
```

Jangan timpa entry yang sudah ada, tambahkan/gabung. 3. Project aktif: tambah ADR `## YYYY-MM-DD — [judul]` ke `decisions.md`; tambah insight ke `learnings.md`; copy yang generalizable ke `knowledge/<topik>.md` (kebab-case, append jika topik ada). 4. Backfill minimal 1 wiki-link valid per file disentuh. 5. Tidak hapus inbox, tidak konsolidasi ke summaries. Laporkan file ditulis/diupdate + next step.

### check — Konsolidasi ke Summaries (destruktif terkontrol)

1. **Dry-run dulu.** Hanya baca/search. Jangan `write`, `edit`, `rm`, `mv`, atau shell mutasi.
2. Scan `knowledge/`, `projects/*/learnings.md`, `projects/*/decisions.md`, `daily/`, `inbox/YYYY-MM-DD/`, `summaries/`. Ekstrak `## TL;DR`, kelompokkan semantik: duplikat, related, orphan, noise.
3. Tampilkan preview: summary baru/update + insight + sumber; file/section dihapus/diubah; backlink diperbaiki. Berhenti, minta konfirmasi eksplisit.
4. Setelah konfirmasi, terapkan hanya rencana disetujui:
   - Summary ada: append dedup + update TL;DR + Changelog. Belum ada: buat dari `meta/summary-template.md` (section TL;DR, Changelog, Detail, See Also).
   - Hapus source hanya jika ekstraksi lengkap terverifikasi: knowledge habis → hapus file; learnings habis → hapus section/file jika kosong; daily fully extracted/noise → hapus, partial → pertahankan log penting; inbox terverifikasi masuk summary → hapus entry disetujui; folder project hanya jika eksplisit di preview.
5. Validasi: satu `## TL;DR` per file aktif, tidak ada backlink mati, jalankan `/memory audit` di akhir.
6. Laporkan summary baru/update, file dihapus/dipertahankan, next step.

### audit — Cek Struktur (read-only)

Jalankan `/vault-audit` (extension `obsidian-memory`). Laporkan file tanpa wiki-link valid. Jangan buat, ubah, atau hapus file.
