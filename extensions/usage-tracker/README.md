# Usage Tracker

Extension ini mendaftarkan `/usage-tracker` dengan dashboard full-overlay untuk:

- session usage/rate limit akun Codex OAuth;
- bar penggunaan untuk setiap window provider;
- persentase pemakaian, sisa kuota, dan waktu reset atau habis;
- usage token session Pi saat ini.

Credential diambil melalui `ctx.modelRegistry.getProviderAuth("openai-codex")`, sehingga OAuth dari `auth.json` tetap mengikuti mekanisme refresh bawaan Pi. Token tidak pernah ditampilkan atau dilog.

Provider hanya ditampilkan jika endpoint session usage mengembalikan window limit. API key biasa dan provider tanpa endpoint quota subscription sengaja disembunyikan.

Catatan:

- Codex memakai endpoint backend `https://chatgpt.com/backend-api/wham/usage`, yang merupakan endpoint internal dan dapat berubah.
- Jika tidak ada provider dengan session usage, dashboard hanya menampilkan usage session Pi lokal.
