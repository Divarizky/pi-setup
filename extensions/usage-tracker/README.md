# Usage Tracker

Extension ini mendaftarkan quota bar real-time di atas editor dan `/usage-tracker` dengan dashboard full-overlay untuk:

- session usage/rate limit akun Codex OAuth;
- bar penggunaan untuk setiap window provider;
- persentase pemakaian, sisa kuota, dan waktu reset atau habis;
- session usage token Pi saat ini;
- sisa kuota resmi per model dan per koneksi (Codex, Antigravity, Zenith Router, dll.);
- quota bar ringkas untuk provider aktif, tanpa menampilkan nama model;
- usage token harian untuk provider yang memiliki kuota upstream resmi.

Credential diambil melalui `ctx.modelRegistry.getProviderAuth("openai-codex")`, sehingga OAuth dari `auth.json` tetap mengikuti mekanisme refresh bawaan Pi. Token tidak pernah ditampilkan atau dilog.

Provider upstream hanya ditampilkan jika endpoint session usage atau response API mengembalikan limit token dan remaining token yang valid. Provider baru dari `auth.json` otomatis terdeteksi jika memakai header token rate-limit standar; credential saja tidak cukup. Provider yang terhubung lewat 9Router ditampilkan dari catatan lokal `usageDaily` sebagai usage token, status koneksi, dan biaya tercatat; 9Router tidak menyediakan sisa kuota upstream yang dapat dihitung secara umum.

Provider yang terhubung lewat Zenith Router (aplikasi gateway lokal port 20120; provider Pi-nya bernama `zenith`) dibaca dari `GET /api/quota`. Satu request mengembalikan kuota terakhir semua koneksi dari database Zenith, jadi endpoint ini tidak memanggil provider upstream dan tidak butuh kredensial; secara default endpoint itu hanya menerima koneksi loopback, dan `ZENITH_URL` dapat diarahkan ke host lain. Pembacaan itu tidak menunggu provider `zenith` terdaftar di Pi: kuota tetap tampil selama gateway-nya berjalan. Koneksi bersaldo, misalnya OpenRouter, tampil sebagai saldo, bukan bar persentase.

Catatan:

- Codex memakai endpoint backend `https://chatgpt.com/backend-api/wham/usage`, yang merupakan endpoint internal dan dapat berubah.
- Claude Pro/Max (provider `claude` dari provider-gateway) membaca token dari `~/.claude/.credentials.json` dan memanggil `https://api.anthropic.com/api/oauth/usage` paling sering sekali per 5 menit untuk semua instance Pi. Hasilnya disimpan di `~/.pi/agent/cache/claude-usage.json`. Respons 429 menyimpan `retry-after` sebagai backoff, dan token yang sudah kedaluwarsa tidak dipakai untuk request.
- Setiap turn Claude, provider-gateway meneruskan `rate_limit_event` dari Claude CLI lewat channel `claude:rate-limit` dan menulisnya ke `~/.pi/agent/cache/claude-rate-limit.json`. Data ini dipakai bila lebih baru dari hasil endpoint. Bila endpoint gagal, quota bar tetap menampilkan snapshot terakhir dengan tanda `stale`.
- Jika tidak ada provider dengan session usage atau database 9Router, dashboard tetap menampilkan usage session Pi lokal.
- Database 9Router dibaca read-only ketika `/usage-tracker` dijalankan; API key dan token tidak dibaca untuk ditampilkan.
- Quota bar mengikuti `model_select`, melakukan refresh berkala, dan disembunyikan untuk model gratis atau tanpa quota terverifikasi.
- Progress bar quota menggunakan satu warna teks dari tema Pi (tanpa warna severity).
- Jika daftar quota melebihi tinggi terminal, gunakan tombol panah/PageUp/PageDown untuk menggulir.
- `GET /api/quota` adalah endpoint control-plane Zenith dan hanya dapat diakses dari loopback; API key gateway tidak dipakai untuk membaca kuota.
- Hasil kuota Zenith disimpan di `~/.pi/agent/cache/zenith-quota.json`. Snapshot kuota ditandai `stale` bila umurnya lebih dari 15 menit, baik ketika gateway berjalan maupun ketika cache terakhir dipakai karena gateway mati. Tanda itu muncul di quota bar dan di baris dashboard. Cache dipanggil ulang paling sering sekali per menit.
- Kuota Zenith dipetakan ke quota bar lewat prefix alias modelnya (`cx/...` -> `codex`, `ag/...` -> `antigravity`, `cl/...` -> `cline`). Koneksi nonaktif tidak ditampilkan. Koneksi aktif tanpa bar kuota maupun saldo juga tidak ditampilkan, kecuali Zenith melaporkan `error` untuk koneksi itu.
- Extension membuat `x-9r-cli-token` dari credential CLI lokal 9Router hanya untuk memanggil `/api/usage/{connectionId}`. Token tidak ditampilkan atau disimpan ulang.
