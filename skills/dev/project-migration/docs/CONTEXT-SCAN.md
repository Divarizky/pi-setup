# Context Scan

Dipakai di dua tempat: `setup-workflow` Step 3 (versi ringan, existing project) dan `project-migration` Step 1 (versi penuh, sebelum migrasi).

## Versi Ringan (setup-workflow)

Tujuan: isi awal `.workspace/context/AGENT.md` (quick) + `.workspace/context/CONTEXT.md` (detail), bukan analisis mendalam. Ikuti **Aturan Split** di `setup-workflow`: temuan 1-baris → AGENT.md, penjelasan/pattern/edge case → CONTEXT.md. `--no-context` → semua ke AGENT.md.

Scan:
- Struktur folder top-level + pattern arsitektur yang kelihatan (MVC, MVVM, layered, dll)
- Dependency utama dari file manifest (`package.json`, `pubspec.yaml`, `build.gradle`, `Podfile`)
- Istilah domain yang muncul berulang di nama class/fungsi/comment
- **Style reference candidate** — file yang mewakili gaya coding project (widget screen, service, repository, dll)

Output: entry kedua file secukupnya untuk agent tidak "buta" saat mulai kerja. Termasuk `style_reference_candidates` array di AGENT.md untuk Step 3a capture. Tidak perlu lengkap — akan terus terisi lewat `ask-me` grill dan sesi kerja berikutnya.

## Versi Penuh (project-migration)

Tujuan: dasar untuk Risk Register (Step 2), jadi harus lebih dalam dari versi ringan.

Scan tambahan:
- Peta dependency antar modul — siapa memanggil siapa, coupling tersembunyi
- Modul mana yang shallow (interface hampir sekompleks implementasinya) vs deep
- Test coverage existing per area — area tanpa test = risk tinggi otomatis
- Cross-check terhadap `.workspace/context/ADR.md` — keputusan mana yang sudah final, jangan diusulkan ulang tanpa alasan kuat

Output: draft awal tiap entry Risk Register (`RISK-REGISTER-TEMPLATE.md`) — problem, dependency type, seam status per kandidat.

## Style Reference Candidate Extraction (Heuristik)

Ekstrak kandidat file yang cocok jadi style reference:

```python
def find_style_reference_candidates(root_path: str) -> list[str]:
    candidates = []
    # Prioritas: UI screen > service > repository > model
    patterns = [
        "**/presentation/screens/*.dart",
        "**/presentation/pages/*.dart",
        "**/presentation/views/*.dart",
        "**/data/services/*.dart",
        "**/data/repositories/*.dart",
        "**/domain/usecases/*.dart",
        "**/core/*.dart",
    ]
    for pattern in patterns:
        matches = glob(pattern, root=root_path)
        for m in matches:
            if file_size(m) > 50 and file_size(m) < 500:  # substantif tapi nggak terlalu besar
                candidates.append(m)
        if candidates:
            break  # ambil dari prioritas tertinggi yang ketemu
    return candidates[:3]  # max 3 kandidat
```

Kriteria file cocok:
- Ukuran 50-500 baris (substantif, representatif)
- Bukan generated code (cek header comment)
- Bukan test file
- Memiliki pattern yang konsisten (import, naming, structure)

## Prinsip

Jangan mulai propose solusi di tahap ini. Context scan murni observasi — solusi/migration plan baru masuk di Step 3 `project-migration`.