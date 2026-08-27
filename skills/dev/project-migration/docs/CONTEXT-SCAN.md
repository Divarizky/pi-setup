# Context Scan

Dipakai di dua tempat: `setup-workflow` Step 3 (versi ringan, existing project) dan `project-migration` Step 3 (versi penuh, setelah strategi migrasi ditentukan).

## Lightweight Version (setup-workflow)

Tujuan: isi awal `.workspace/context/PROJECT.md` (quick) + `.workspace/context/CONTEXT.md` (detail), bukan analisis mendalam. Ikuti **Aturan Split** di `setup-workflow`: temuan 1-baris → PROJECT.md, penjelasan/pattern/edge case → CONTEXT.md. `--no-context` → semua ke PROJECT.md.

Scan:

- Struktur folder top-level + pattern arsitektur yang kelihatan (MVC, MVVM, layered, dll)
- Dependency utama dari file manifest (`package.json`, `pubspec.yaml`, `build.gradle`, `Podfile`)
- Istilah domain yang muncul berulang di nama class/fungsi/comment

Output: entry kedua file secukupnya untuk agent tidak "buta" saat mulai kerja. Tidak perlu lengkap — akan terus terisi lewat `ask-me` grill dan sesi kerja berikutnya.

## Full Version (project-migration)

Tujuan: dasar untuk Risk Register (Step 4), jadi harus lebih dalam dari versi ringan.

Scan tambahan:

- Peta dependency antar modul — siapa memanggil siapa, coupling tersembunyi
- Modul mana yang shallow (interface hampir sekompleks implementasinya) vs deep
- Test coverage existing per area — area tanpa test = risk tinggi otomatis
- Cross-check terhadap `.workspace/context/ADR.md` — keputusan mana yang sudah final, jangan diusulkan ulang tanpa alasan kuat

Output: draft awal tiap entry Risk Register (`RISK-REGISTER-TEMPLATE.md`) — problem, dependency type, seam status per kandidat.

## Principles

Jangan mulai propose solusi di tahap ini. Context scan murni observasi — solusi/migration plan baru masuk di Step 3 `project-migration`.
