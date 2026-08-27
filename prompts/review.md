---
description: Deep review seluruh codebase
argument-hint: "[path-atau-fokus]"
---

Lakukan deep review menyeluruh terhadap codebase${1:+ dengan fokus pada $@}.

**Prasyarat — Konteks**: Baca file manifest project untuk identifikasi stack, lalu tailor cek ke ecosystem tooling:

- Web/Backend: `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `composer.json`, `pom.xml`
- Android: `build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`
- iOS: `Package.swift` (SwiftPM) atau `Podfile`+`Podfile.lock` (CocoaPods)
- Flutter: `pubspec.yaml`
- React Native/Expo: `package.json`, `app.json`/`app.config.js`
- KMP: `build.gradle.kts` + `gradle/libs.versions.toml`
- CI/CD mobile: `fastlane/`, `codemagic.yaml`, `bitrise.yml`
- Hardening: `proguard-rules.pro`, `r8` config

Cakupan review:

- **Arsitektur & struktur**: organisasi modul, separation of concerns, coupling/cohesion, dependency tidak perlu, **mono-repo drift**.
- **Bug & logika**: edge case, off-by-one, null/undefined, race condition, error handling hilang/menelan error.
- **Keamanan**: validasi input di **trust boundary** (API endpoint, DB query, file upload, env var, queue consumer), injection, secret hardcoded, auth/authz, **dependency rentan (supply chain, license, outdated, unused)**.
- **Performa**: query N+1, **unindexed query**, **missing pagination**, loop boros, alokasi tidak perlu, **blocking I/O di hot path**, **sync fs di async**, **memory leak pattern**, **large bundle**.
- **Kualitas**: duplikasi, dead code, abstraksi berlebihan, penamaan, kompleksitas, konsistensi gaya.
- **Test**: coverage area kritis, test rapuh/menyesatkan, kasus hilang, **mutation testing gap**.

Cara kerja:

1. Petakan struktur proyek (file penting, entry point, config, dependency).
2. Baca file inti, jangan asumsi—buka isinya.
3. Laporkan temuan per severity:
   - **Critical**: RCE / data loss / prod down / auth bypass
   - **High**: logic bug / injection / data corruption
   - **Medium**: perf degradation / maintainability / sec hygiene
   - **Low**: style / nit / doc
4. Tiap temuan: `path:line`, masalah, dampak, **suggested fix (diff pseudo-code)**.
5. Tutup: **3-5 prioritas utama** + quick wins.

Jangan ubah kode—review baca-saja kecuali diminta.
