---
description: Review diff git saat ini (staged dan uncommitted) melalui subagent reviewer
argument-hint: "[fokus-opsional]"
---
Review diff git di repo ini${1:+ dengan fokus pada $@}.

Langkah:
1. Jalankan `git status --short` dan `git diff HEAD --stat`. Jika tidak ada perubahan tracked maupun untracked, laporkan "Tidak ada diff untuk di-review" lalu berhenti.
2. Delegasikan audit ke subagent `reviewer` lewat Agent tool dengan `subagent_type: "reviewer"`. Sertakan di prompt: hasil `git status --short`, perintah diff yang dipakai (`git diff HEAD`), dan fokus tambahan jika ada.
3. Subagent `reviewer` berstatus read-only. Jangan mengubah berkas apa pun di tahap ini.
4. Verifikasi hasil subagent sebelum menyajikannya: setiap temuan harus punya `path:line`, bukti, dan dampak. Buang temuan yang tidak punya bukti, lalu catat pembuangannya.
5. Untuk setiap temuan yang tersisa, cek ulang `path:line` secara langsung dengan `read` pada hunk yang dirujuk.

Format laporan akhir (Bahasa Indonesia):

## Ringkasan
- Berkas berubah: <jumlah>, daftar path.
- Verdict: <clean | findings: N>.

## Temuan per berkas

Kelompokkan per berkas, lalu per hunk. Urutkan P0 ke P3 di dalam setiap berkas.

### `<path>`

#### Hunk `<@@ header>` (baris `<awal>-<akhir>`)
- Keparahan: P<0-3>
- Masalah: <satu kalimat>
- Bukti: <perintah reproduksi dan hasil, atau jejak path:line -> path:line>
- Dampak: <akibat konkret pada perilaku, data, atau konsumen>
- Perbaikan minimal: <perubahan paling kecil>

## Konsumen terdampak
Tulis hanya jika ada perubahan signature, tipe publik, atau kontrak API. Daftar `path:line` konsumen yang sudah diperiksa.

## Tidak diverifikasi
Area yang tidak bisa dibuktikan dalam sesi ini, atau "tidak ada".

## Batasan
- Jangan mengubah kode. Ini review baca-saja.
- Jangan menyajikan saran gaya atau penamaan yang tidak terkait aturan proyek.
- Jika subagent gagal atau tidak mengembalikan hasil, laporkan kegagalannya dengan pesan error yang diterima. Jangan membuat temuan sendiri sebagai pengganti.
