---
description: Gerbang terpadu code review (path, branch/commit, atau diff otomatis)
argument-hint: "[path|branch|commit|fokus]"
---
Jalankan code review read-only. Target atau fokus: ${@:-otomatis}.

## 1. Routing Target
1. Jika argumen menunjuk path atau direktori, audit berkas pada target tersebut dengan mengikuti prasyarat konteks dan membaca berkas inti terkait.
2. Jika argumen menunjuk branch, commit, atau range git, gunakan `git diff <target>` (atau `<target>...HEAD` untuk branch).
3. Jika tanpa argumen atau hanya fokus deskriptif, jalankan `git status --porcelain`:
   - Working tree kotor: audit uncommitted diff (`git diff HEAD` dan daftar berkas untracked).
   - Working tree bersih: cek `git rev-parse -q --verify origin/main` (gunakan `origin/main...HEAD`); jika tidak ada, cek `git rev-parse -q --verify HEAD~1` (gunakan `HEAD~1..HEAD`); jika keduanya tidak ada, laporkan `BLOCKED` dengan alasan "tidak ada base ref" lalu berhenti.
4. Jika tidak ada diff atau target yang dapat diaudit, laporkan `"Tidak ada diff atau target untuk di-review"` lalu berhenti.

**Prasyarat — Konteks**: Baca file manifest project untuk identifikasi stack, lalu tailor cek ke ecosystem tooling:
- Web/Backend: `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `composer.json`, `pom.xml`
- Android: `build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`
- iOS: `Package.swift` (SwiftPM) atau `Podfile`+`Podfile.lock` (CocoaPods)
- Flutter: `pubspec.yaml`
- React Native/Expo: `package.json`, `app.json`/`app.config.js`
- KMP: `build.gradle.kts` + `gradle/libs.versions.toml`
- CI/CD mobile: `fastlane/`, `codemagic.yaml`, `bitrise.yml`
- Hardening: `proguard-rules.pro`, `r8` config

## 2. Eksekusi & Verifikasi
- Mode diff, branch, atau commit MUST didelegasikan ke subagent `reviewer` via Agent tool (`subagent_type: "reviewer"`) dengan menyertakan `git status --short`, perintah diff, dan fokus.
- Verifikasi setiap temuan dengan `read` langsung pada `path:line` terkait; buang temuan tanpa bukti dan catat pembuangannya.
- NEVER memodifikasi berkas, staging area, atau membuat commit.
- Jika subagent gagal, laporkan pesan error yang diterima; NEVER mengarang temuan pengganti.

## 3. Taksonomi Triage & Aturan Temuan
- Provable Findings Only: NEVER melaporkan spekulasi, preferensi gaya penulisan, atau nitpick kosmetik.
- Klasifikasi keparahan:
  - **P0**: crash fatal, RCE, kebocoran kredensial/rahasia, korupsi/kehilangan data, deadlock.
  - **P1**: bug perilaku, regresi logika, pelanggaran kontrak API publik, memory leak, unhandled edge case pada alur utama.
  - **P2**: edge case dan boundary yang tidak ditangani, degradasi performa, missing error handling I/O sekunder.
  - **P3**: advisory maintainability non-blocking (kode mati, dead branch, diskrepansi dokumentasi terhadap perilaku nyata).
- Setiap temuan MUST memuat label `[High confidence]` atau `[Medium confidence]`.
- Temuan `Low confidence` MUST NOT dilaporkan sebagai blocker.

## 4. Format Laporan (Bahasa Indonesia)
- **Ringkasan**: target atau perintah diff, jumlah berkas, verdict (`clean` | `findings: N`).
- **Temuan per berkas (urut P0 → P3)**: `path:line` (serta header hunk untuk diff), `[P0-P3] [High|Medium confidence]`, Masalah, Bukti (reproduksi atau jejak eksekusi), Dampak konkret, dan Perbaikan minimal.
- **Konsumen terdampak** *(bila ada perubahan signature/kontrak)*: daftar `path:line` pemanggil yang diperiksa.
- **Tidak diverifikasi**: area yang tidak dapat dibuktikan, atau `"tidak ada"`.
