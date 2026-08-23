# Cutover Strategy

Tentukan cara project baru menggantikan project lama. Tanya user di awal `SKILL.md`, bersamaan dengan Migration Approach.

## Opsi A — Bertahap (Project Lama & Baru Jalan Bersamaan)

Migrasi per fitur/modul. Fitur yang sudah pindah, langsung dipakai di project baru. Fitur yang belum, tetap di project lama. Project lama makin lama makin kosong sampai akhirnya bisa dimatikan.

**Cocok untuk**: aplikasi dengan banyak fitur, tidak bisa berhenti total selama migrasi, ingin validasi tiap fitur sebelum lanjut ke berikutnya.

**Contoh**: e-commerce, fitur checkout dipindah duluan ke project baru, fitur catalog masih di project lama. Routing arahkan `/checkout` ke baru, `/catalog` ke lama.

**Konsekuensi ke flow**: Migration Plan (Step 3) butuh urutan fitur berdasarkan Risk Register, plus catatan koordinasi dua sistem jalan bersamaan (routing, data sync kalau perlu).

## Opsi B — Sekali Jalan (Cutover Penuh)

Semua fitur selesai dulu di project baru, baru project lama dimatikan sekaligus. Tidak ada masa transisi jalan bersamaan.

**Cocok untuk**: project kecil/personal, scope migrasi terbatas, tidak ada constraint uptime selama migrasi.

**Contoh**: aplikasi mobile internal, semua fitur dikerjakan di project baru, testing menyeluruh, rilis baru + tarik versi lama sekaligus.

**Konsekuensi ke flow**: Migration Plan (Step 3) lebih sederhana — tidak perlu step koordinasi dua sistem, tapi risiko terpusat di satu titik cutover akhir.

## Pertanyaan ke User

1. Project lama boleh berhenti total selama migrasi, atau harus tetap jalan?
2. Kalau boleh berhenti — berapa lama toleransi downtime yang bisa diterima?

Jawaban menentukan Opsi A atau B.
