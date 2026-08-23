---
name: prototype
description: "Buat prototipe throwaway untuk jawab pertanyaan desain — eksplorasi state/logic lewat TUI terminal, atau perbandingan varian UI. Pakai saat user mau validasi state model, eksplorasi edge case logic, atau bandingkan opsi layout sebelum commit ke implementasi."
disable-model-invocation: true
---

# Prototipe

**Kode throwaway yang jawab satu pertanyaan.** Pertanyaan nentuin bentuknya.

Cabang otomatis dari pertanyaan user:

| Pertanyaan | Cabang |
|---|---|
| "Apakah state machine / reducer ini handle edge case X?" | `docs/LOGIC.md` — terminal TUI |
| "Gimana kalo tampilannya beda?" | `docs/UI.md` — variant switcher |

Ambigu & user tidak reachable → default LOGIC (backend-heavy) atau UI (frontend-heavy). State assumption di atas prototipe.

## Prasyarat

[Prasyarat](../shared/COMMON.md#prasyarat) — `.workspace/project-meta.md` opsional. Universal mode tetap berjalan dengan context terbatas dan capture chat-only; Project-aware mode dapat memakai context/artifact yang tersedia.

## Aturan Universal

1. **Throwaway sejak hari pertama, jelas tandanya.** Nama file/fungsi/route mengandung `prototype` atau `_proto`. Jangan samar jadi production code.
2. **Satu command untuk run.** Apapun task runner — `dart run`, `flutter run`, `npm run`, `swift run`, `python`, `bun`. User tinggal ketik tanpa mikir path.
3. **Tanpa persistence.** State in-memory. Persistence hanya jika pertanyaan eksplisit tentang DB. Project-aware mode boleh memakai scratch DB/file `PROTOTYPE-wipe-me`; Universal mode jangan membuat persistence artifact dan tampilkan hasilnya di chat.
4. **Skip polish.** Tanpa test, tanpa error handling di luar yang bikin runnable, tanpa abstraksi. Poin: belajar secepat mungkin.
5. **Surface state.** Setiap action (LOGIC) atau switch variant (UI), tampilkan state penuh — user lihat apa yang berubah.
6. **Capture saat selesai.** Validated decision → fold ke real code. Prototipe → commit ke throwaway branch (jangan main). Project-aware mode → tulis ke `.workspace/.scratch/<slug>/prototype-decision.md`. Universal mode → tampilkan decision capture dan statusnya di chat; jangan membuat file.

## Format Capture

```markdown
# Prototype Decision — <nama>

**Pertanyaan:** <satu kalimat>
**Cabang:** LOGIC | UI
**Jawaban:** <kesimpulan>
**Tanggal:** <YYYY-MM-DD>
**Branch prototipe:** <nama branch>

**Yang divalidasi:** <bagian yang diambil ke real code>
**Yang dibuang:** <bagian yang di-throwaway>
```

## Anti-pola

- **Test** — prototipe butuh test bukan prototipe lagi
- **Generalisasi** — "nanti kalo perlu X tinggal tambah" — stop, jawab satu pertanyaan
- **Campur logic & TUI** (LOGIC) — pure module harus bisa di-lift tanpa terminal code
- **Varian beda warna doang** (UI) — beda struktur, bukan beda skin
- **Promote langsung ke production** — prototipe tanpa test/error handling/abstraksi. Tulis ulang proper saat fold.

## Kapan Pakai vs Skip

| Situasi | Aksi |
|---|---|
| State machine rawan edge case | LOGIC |
| API contract belum fix | LOGIC (mock + terminal) |
| Layout UI belum decided | UI |
| Task sederhana, behavior jelas | Skip — `implement` langsung |
| Refactor code existing | Skip — `improve-architecture` |
| Persistensi / network call real | Skip — prototipe tanpa persistence |

## Saran Skills Lain

[Workflow](../WORKFLOW.md) — Validasi desain sebelum implement → `prototype` dulu, baru `to-issues`/`implement`.