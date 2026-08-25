# Migration Approach

Tentukan pendekatan penulisan kode di project baru. Tanya user di awal `SKILL.md`, sebelum context intake.

## Opsi A — Bangun Ulang dari Nol

Kode lama jadi referensi behavior. Kode baru ditulis fresh — bebas ubah struktur, pattern, bahkan bahasa/framework.

**Cocok untuk**: platform baru beda total (web ke mobile), tech debt lama terlalu berat untuk dipertahankan, arsitektur lama sudah tidak relevan.

**Contoh**: Android Java View-based → Android Kotlin Jetpack Compose. Logic bisnis dipahami dari kode lama, kode Compose ditulis dari nol.

**Konsekuensi ke flow**: Migration Plan (Step 3) lebih dekat proses `implement` — spec ulang tiap behavior, TDD dari nol per modul.

## Opsi B — Pindahkan dengan Penyesuaian

Kode existing dipindah ke project baru, diubah seperlunya (update dependency, fix incompatibility, sesuaikan struktur folder). Logic inti tetap sama persis.

**Cocok untuk**: platform sama, upgrade versi framework/dependency, restrukturisasi folder tanpa ubah logic.

**Contoh**: Express.js versi lama → Express.js versi baru. Copy file, update import, fix breaking changes — logic tidak ditulis ulang.

**Konsekuensi ke flow**: Migration Plan (Step 3) lebih dekat proses `bug-diagnosis` — jaga behavior identik, test characterization dulu sebelum ubah apapun.

## Pertanyaan ke User

1. Platform lama dan baru sama atau beda?
2. Tujuan migrasi: ganti teknologi/arsitektur, atau cuma pindah + update versi?

Jawaban menentukan Opsi A atau B. Kalau campuran (sebagian modul rewrite, sebagian port) — catat per modul di Risk Register, bukan satu keputusan global.
