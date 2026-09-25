---
name: prototype
description: "Buat prototype runnable mandiri di `.workspace/prototypes/` untuk menjawab satu pertanyaan desain UI atau logic; brief yang disetujui menjadi izin untuk mulai coding."
disable-model-invocation: true
---

# Prototype

**Runnable-first, bukan production-first.** Prototype adalah kode throwaway yang bisa dicoba untuk menjawab satu pertanyaan desain atau logic. Setelah user menyetujui brief, buat prototype runnable tanpa meminta opt-in runnable kedua. Simpan semua artifact kode di `.workspace/prototypes/` agar dapat direview sebelum implementasi fitur.

Prototype harus mandiri dan tidak mengubah source/route aplikasi. Jangan menulis production code, mengubah behavior production, menambah persistence/backend nyata, atau otomatis menjalankan skill lanjutan.

## Lokasi Artifact

Sebelum coding, tentukan work root: Git root jika tersedia; jika bukan repo Git, gunakan current directory. Buat satu subfolder unik per prototype:

```text
<work-root>/.workspace/prototypes/<slug>/index.html
```

Semua file prototype dan asset pendukung harus berada di subfolder tersebut. Jangan menimpa prototype yang sudah ada; pilih slug lain jika path sudah dipakai. Jangan membuat `.workspace/project-meta.md` hanya untuk menyimpan prototype.

- Branch `UI` dan `LOGIC` sama-sama menyimpan artifact runnable di lokasi ini.
- Project mode: decision capture tetap ditulis ke section `## Prototype Decision` pada `.workspace/work/F-<id>.md`. Jika work card belum ada, alokasikan `F-<id>` dan buat card melalui pola `to-requirements` terlebih dahulu.
- Universal mode: artifact runnable tetap dibuat di `.workspace/prototypes/`; decision capture ditampilkan di chat dan **jangan membuat file decision `.md`**.

## Design Brief and Approval Gate

Sebelum coding, buat brief singkat dan minta persetujuan user. Jangan mulai dari asumsi yang belum terlihat.

```markdown
# Prototype Brief — <name>

**Question:** <satu pertanyaan yang harus dijawab>
**Hypothesis:** <jawaban/dugaan yang ingin diuji>
**Branch:** LOGIC | UI
**Context:** <screen, module, data, dan sumber yang sudah tersedia>
**Success criteria:** <sinyal observable yang membuktikan jawaban>
**Constraints:** <runtime, platform, accessibility, waktu, atau batasan lain>
**Out of scope:** <hal yang sengaja tidak diuji>
**Research needed:** <none atau pertanyaan/sumber yang perlu dicek>
```

Aturan gate:
1. Brief harus menjawab **satu** pertanyaan dan punya success criteria yang bisa diamati.
2. Jika `Research needed` tidak kosong, lakukan riset terfokus dan rangkum temuan + sumber sebelum meminta persetujuan brief.
3. Tampilkan brief dan minta persetujuan eksplisit (gunakan `ask_user` bila tersedia). Revisi brief bila user memberi feedback.
4. **Persetujuan brief adalah izin untuk mulai coding prototype runnable.** Jangan meminta opt-in atau approval runnable kedua. Jika user belum menyetujui brief, jangan coding.
5. Setelah brief disetujui, lakukan context review dan buat artifact mandiri di `.workspace/prototypes/<slug>/`. Jangan mengubah source/route aplikasi. Minta approval baru hanya jika scope atau constraint perlu diperluas.
6. Satu sesi hanya mengerjakan satu prototype question.

## Branch Selection

| Pertanyaan | Branch |
|---|---|
| "Apakah state machine / reducer ini handle edge case X?" | `LOGIC` — demo interaktif untuk state, transition, dan invariant |
| "Gimana kalau tampilannya beda?" | `UI` — beberapa varian layout dan interaction yang bisa dibandingkan |

Jika ambigu, default ke `LOGIC` untuk pertanyaan backend/state atau `UI` untuk frontend/layout, lalu tuliskan asumsi di brief.

## Prototype Workflow

1. **Brief** — tulis question, hypothesis, criteria, context, dan batasan.
2. **Approval** — persetujuan brief mengizinkan pembuatan prototype runnable.
3. **Context review** — baca code, docs, data shape, design system, dan constraint yang relevan. Gunakan hanya sebagai referensi untuk artifact mandiri.
4. **Build and run** — buat prototype runnable di `.workspace/prototypes/<slug>/`. Gunakan bentuk yang ditentukan branch UI atau LOGIC.
5. **Review** — berikan path, URL/file, dan instruksi run; minta user mencoba atau me-review, termasuk bagian yang disukai, membingungkan, atau ingin digabung.
6. **Evaluate** — jadikan feedback user bukti utama. Cocokkan secara ringkas dengan success criteria, trade-off, accessibility/responsive concern, dan risiko. Jangan mengubah selera menjadi klaim validasi tanpa evidence.
7. **Capture** — Project mode memperbarui section `## Prototype Decision` pada `.workspace/work/F-<id>.md`; Universal mode menampilkan decision capture di chat.
8. **Cleanup** — setelah decision capture selesai, hapus hanya subfolder prototype yang dibuat untuk pertanyaan ini. Tampilkan path sebelum cleanup; jangan menghapus parent `.workspace/prototypes/`, subfolder lain, atau file existing. Jika batasnya tidak jelas, berhenti dan minta konfirmasi.
9. **Phase exit** — sarankan skill berikutnya, tetapi jangan otomatis menjalankannya.

## Batasan Prototype Runnable

- Artifact mandiri: satu `index.html` dengan HTML/CSS/JavaScript inline; asset tambahan hanya jika perlu dan tetap di subfolder prototype.
- Throwaway, in-memory, read-only; tanpa backend mutation, persistence, atau integrasi production.
- Bisa dibuka langsung atau dijalankan dengan satu command yang dicantumkan.
- Lewati test, abstraksi, dan polish yang tidak diperlukan agar demo bisa dijalankan; jangan mengorbankan kejelasan state atau usability demo.
- Keputusan tervalidasi dan design requirements diteruskan lewat decision capture. Kode prototype sendiri tidak dipromosikan atau di-commit otomatis.

## Capture Format

```markdown
# Prototype Decision — <name>

**Question:** <satu kalimat>
**Hypothesis:** <dugaan sebelum prototype>
**Branch:** LOGIC | UI
**Prototype path:** `.workspace/prototypes/<slug>/`
**Status:** validated | inconclusive | rejected
**Success criteria:** <sinyal observable>
**User feedback:** <pilihan, komentar, atau `not reviewed`>
**Evidence:** <observasi dan sumber, bukan asumsi>
**Options considered:** <opsi + trade-off>
**Decision:** <kesimpulan>
**Date:** <DD-MM-YYYY>

**Validated for real code:** <behavior, logic, atau design requirements yang boleh dibawa ke implementasi>
**Rejected/discarded:** <bagian yang dibuang dan alasannya>
**Open risks:** <risiko yang belum terjawab atau `none`>
**Suggested next skill:** `implement` | `to-tasks` | `improve-architecture` | `prototype` | `ask-me` | `none`
```

## Phase Exit

Setelah decision capture selesai:

1. Project mode: tampilkan ringkasan keputusan dan path `.workspace/work/F-<id>.md`. Universal mode: tampilkan ringkasan keputusan langsung di chat.
2. Laporkan path prototype dan instruksi menjalankannya sebelum cleanup. Setelah hasil direview dan dicatat, bersihkan hanya subfolder prototype untuk pertanyaan ini sesuai aturan cleanup.
3. Sarankan skill berikutnya berdasarkan hasil:
   - `implement` — keputusan tervalidasi dan siap dibuat;
   - `to-tasks` — keputusan perlu dipecah menjadi task;
   - `improve-architecture` — keputusan membutuhkan refactor/desain teknis;
   - `prototype` — hasil inconclusive dan perlu eksplorasi ulang;
   - `ask-me` — requirement masih ambigu;
   - `none` — tidak ada tindakan lanjutan.
4. Jangan auto-invoke skill tersebut; tunggu pilihan eksplisit user.
5. Setelah capture dan cleanup selesai, berhenti.

Jika success criteria belum terjawab, status wajib `inconclusive`. Jika user menolak hasil, status `rejected` dan alasan penolakan harus dicatat.

## When to Use or Skip

| Situasi | Aksi |
|---|---|
| State machine rawan edge case | Pakai `prototype` branch `LOGIC`; buat demo HTML interaktif di `.workspace/prototypes/` |
| API contract belum fix | Pakai `prototype` untuk mencoba model dan failure mode yang bisa diamati |
| Layout UI belum diputuskan | Pakai `prototype` branch `UI`; bandingkan varian runnable mandiri di `.workspace/prototypes/` |
| User perlu melihat interaksi nyata | Persetujuan brief cukup untuk mulai membangun prototype runnable |
| Task sederhana, behavior jelas | Skip — `implement` langsung |
| Refactor code existing | Skip — `improve-architecture` |
| Pertanyaan membutuhkan persistence/network real | Jangan hubungkan prototype ke dependency real; gunakan stub atau in-memory state |

## Anti-Patterns

- Langsung coding sebelum brief disetujui.
- Meminta approval runnable terpisah setelah brief disetujui.
- Menyimpan artifact prototype di luar `.workspace/prototypes/<slug>/`.
- Mengubah source/route aplikasi agar prototype standalone dapat berjalan.
- Menganggap prototype adalah production code.
- Menambah test, persistence, atau real backend mutation.
- Membuat lebih dari satu pertanyaan/keputusan dalam satu prototype.
- Menghapus kode existing atau subfolder prototype lain saat cleanup.
- Menganggap hasil inconclusive sebagai keputusan final.
- Auto-invoke `implement` atau skill lain setelah decision capture.

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Validasi satu pertanyaan desain/logic dengan prototype runnable; setelah review, gunakan `implement` atau `to-tasks` sesuai keputusan.
