# Usage Tracker

Extension ini mendaftarkan quota bar real-time di atas editor dan `/usage-tracker` dengan dashboard full-overlay untuk:

- session usage/rate limit akun Codex OAuth;
- bar penggunaan untuk setiap window provider;
- persentase pemakaian, sisa kuota, dan waktu reset atau habis;
- session usage token Pi saat ini;
- sisa kuota resmi per model (OpenAI Codex, Antigravity 9Router, dll.);
- quota bar ringkas untuk provider aktif, tanpa menampilkan nama model;
- usage token harian untuk provider yang memiliki kuota upstream resmi.

Credential diambil melalui `ctx.modelRegistry.getProviderAuth("openai-codex")`, sehingga OAuth dari `auth.json` tetap mengikuti mekanisme refresh bawaan Pi. Token tidak pernah ditampilkan atau dilog.

Provider upstream hanya ditampilkan jika endpoint session usage atau response API mengembalikan limit token dan remaining token yang valid. Provider baru dari `auth.json` otomatis terdeteksi jika memakai header token rate-limit standar; credential saja tidak cukup. Provider yang terhubung lewat 9Router ditampilkan dari catatan lokal `usageDaily` sebagai usage token, status koneksi, dan biaya tercatat; 9Router tidak menyediakan sisa kuota upstream yang dapat dihitung secara umum.

Catatan:

- Codex memakai endpoint backend `https://chatgpt.com/backend-api/wham/usage`, yang merupakan endpoint internal dan dapat berubah.
- Jika tidak ada provider dengan session usage atau database 9Router, dashboard tetap menampilkan usage session Pi lokal.
- Database 9Router dibaca read-only ketika `/usage-tracker` dijalankan; API key dan token tidak dibaca untuk ditampilkan.
- Quota bar mengikuti `model_select`, melakukan refresh berkala, dan disembunyikan untuk model gratis atau tanpa quota terverifikasi.
- Progress bar quota menggunakan satu warna teks dari tema Pi (tanpa warna severity).
- Jika daftar quota melebihi tinggi terminal, gunakan tombol panah/PageUp/PageDown untuk menggulir.
- Extension membuat `x-9r-cli-token` dari credential CLI lokal 9Router hanya untuk memanggil `/api/usage/{connectionId}`. Token tidak ditampilkan atau disimpan ulang.
