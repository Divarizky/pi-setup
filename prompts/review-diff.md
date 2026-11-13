---
description: Alias backward-compatible untuk /review (fokus uncommitted/staged diff)
argument-hint: "[fokus-opsional]"
---
Teruskan pemanggilan ini ke protokol `/review` dengan cakupan diff git saat ini (`git diff HEAD` dan berkas untracked). Fokus tambahan: ${@:-tidak ada}.

- Jalankan `git status --porcelain`; jika kosong, hentikan dan laporkan `"Tidak ada diff uncommitted/staged untuk di-review"`.
- Terapkan seluruh aturan **Eksekusi & Verifikasi**, **Taksonomi Triage (P0–P3 + `[High|Medium confidence]`)**, **Provable Findings Only**, dan **Format Laporan** dari gerbang `/review`.
