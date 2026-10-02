---
id: F-01
version: 1.0.0
created: 2026-09-24
updated: 2026-09-24
source: to-requirements
status: approved
---

# F-01 — Tampilan Execute ala Codex

## Problem

Tampilan tool execute saat ini memisahkan baris perintah dan status akhir. Saat proses berjalan, pengguna hanya melihat label umum berisi durasi tanpa cuplikan output. Setelah selesai, yang tampil hanya satu baris status singkat sehingga sulit menilai hasil sekilas. Pengguna meminta pengalaman semirip mungkin dengan Codex: satu blok perintah yang hidup selama eksekusi dan menyisakan cuplikan output yang mudah dibaca setelah selesai.

## Solution

Ubah render execute menjadi satu blok perintah ala Codex. Saat berjalan, blok menampilkan penanda aktif, perintah yang dijalankan, durasi, dan cuplikan stdout atau stderr terbaru yang dibatasi. Setelah selesai, blok menampilkan kata kerja lampau, perintah, status akhir, durasi, dan cuplikan output berindentasi dengan penanda baris yang dihilangkan bila output panjang. Hasil mentah tetap disimpan di cache dan diambil lewat inspect, sehingga tampilan live hanya untuk kenyamanan baca dan tidak mengubah isi yang diterima model.

## User Stories

(MUST) Sebagai pengguna terminal, saya ingin melihat perintah dan cuplikan output dalam satu blok selama eksekusi, agar saya tahu progres tanpa membuka detail.
(MUST) Sebagai pengguna terminal, saya ingin status akhir jelas terlihat termasuk durasi dan kode keluar saat gagal, agar saya cepat memutuskan langkah berikutnya.
(SHOULD) Sebagai pengguna yang menjalankan perintah beroutput besar, saya ingin cuplikan dibatasi dengan penanda jumlah baris yang disembunyikan, agar terminal tidak dibanjiri teks.
(SHOULD) Sebagai pengguna yang memakai inspect, saya ingin output lengkap tetap tersedia lewat cache walau tampilan hanya cuplikan, agar tidak ada informasi yang hilang.
(NICE) Sebagai pengguna terminal sempit, saya ingin blok tetap rapi dan terbaca pada lebar kecil, agar tampilan tidak pecah.

## Acceptance Criteria

1. AC-01: WHEN sebuah skrip sedang berjalan THEN blok eksekusi SHALL menampilkan penanda aktif, teks perintah, durasi berjalan, dan minimal 1 baris cuplikan output setelah output pertama tiba.
2. AC-02: WHEN eksekusi selesai sukses THEN blok SHALL menampilkan kata kerja lampau, teks perintah, status sukses, durasi total, dan cuplikan output berindentasi atau penanda tidak ada output.
3. AC-03: WHEN eksekusi gagal atau timeout THEN blok SHALL menampilkan status gagal atau timeout beserta kode keluar atau sinyal bila tersedia, durasi, dan cuplikan output terakhir yang dibatasi.
4. AC-04: WHEN output melebihi batas cuplikan THEN blok SHALL menampilkan bagian awal dan akhir yang dibatasi dengan satu baris ellipsis berisi jumlah baris yang disembunyikan.
5. AC-05: WHEN tampilan diperluas oleh pengguna THEN sistem SHALL menampilkan hasil akhir yang dibatasi, bukan seluruh log tanpa batas, dan tetap menyebut cara mengambil output lengkap lewat cache.
6. AC-06: WHEN output berisi pembaruan progres satu baris berulang THEN tampilan live SHALL merendernya sebagai satu baris progres terbaru, bukan menumpuk ratusan baris.
7. AC-07: WHEN mode non-interaktif tanpa UI THEN eksekusi SHALL tetap berhasil, destiny error tetap dilempar sesuai kontrak, dan cache output tetap tersimpan walau tanpa tampilan live.
8. AC-08: WHEN pembatalan diminta THEN proses SHALL dihentikan, blok SHALL menampilkan status dibatalkan, dan tidak ada proses anak yang tertinggal berjalan.

## Implementation Decisions

**Final**:

- Tampilan live hanya untuk UI; isi ringkas untuk model dan cache output tidak berubah — agar kompatibilitas inspect dan perilaku model tetap.
- Cuplikan live dibatasi jumlah baris, ukuran teks, dan frekuensi pembaruan — agar output besar tidak membanjiri terminal atau menghambat render.
- Kontrak error tetap lempar saat gagal atau timeout — agar status error model tidak berubah diam-diam.

**Open**:

- Nilai pasti batas baris, ukuran teks, dan interval throttle cuplikan live — perlu validasi saat implementasi via uji terminal nyata.
- Format kata header final dan penanda ellipsis — perlu diputuskan agar konsisten dengan tema dan gaya bahasa existing.

## Testing Decisions

- **Seam(s)**:
  - Pelaksana skrip dengan callback progres berbasis elapsed — titik utama menyisipkan aliran output bertahap tanpa mengubah pengakhiran proses.
  - Render hasil dengan penanda partial versus final — titik utama mengubah tampilan live dan akhir secara terpisah.
  - Penyimpanan output mentah dengan ambil per pengenal — titik utama memastikan cuplikan UI tidak merusak pengambilan lengkap.
- **Test Strategy**: unit untuk progres bertahap, batas cuplikan, dan penanda ellipsis; integration untuk skenario gagal, timeout, pembatalan, dan output besar; uji render manual untuk lebar terminal sempit dan baris progres berulang.
- **Environment**: local; skrip uji lintas platform untuk shell Windows dan non-Windows.

## Out of Scope

- Mengubah izin eksekusi, kebijakan keamanan, atau batas direktori project.
- Mengubah format ringkasan untuk model atau skema cache inspect.
- Interaksi penuh dua arah dengan proses berjalan; live hanya satu arah baca output.
- Pengaturan tema atau keybinding baru di luar blok execute.

## Further Notes

Referensi perilaku acuan adalah renderer sel eksekusi Codex versi open source; yang diadopsi adalah pola blok perintah plus cuplikan, bukan menyalin kode atau gaya visual piksel-per-piksel.

## Tasks

<!-- Diisi `to-tasks`; task aktif tetap berada di work card ini. -->

## Evidence

<!-- Test/commit/validasi setelah implementasi. -->
