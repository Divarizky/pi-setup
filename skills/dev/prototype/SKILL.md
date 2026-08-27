---
name: prototype
description: "Hasilkan keputusan desain/logic dalam Markdown sebelum implementasi. Gunakan prototype executable hanya jika user meminta eksplisit."
disable-model-invocation: true
---

# Prototype

**Decision-first, bukan code-first.** Skill ini menjawab satu pertanyaan desain atau logic dan menghasilkan decision capture dalam Markdown. Jangan membuat TUI, UI, test, persistence, atau production code kecuali user secara eksplisit meminta prototype executable.

## Default Output

Output bergantung pada mode ([deteksi mode](../shared/COMMON.md#prerequisites): marker `.workspace/project-meta.md` tersedia → Project mode; tidak tersedia → Universal mode):

- Project mode: tulis decision capture ke `.workspace/.scratch/<slug>/prototype-decision.md`.
- Universal mode: tampilkan decision capture langsung sebagai pesan chat; **jangan membuat file `.md`**.

Jangan mengubah production code dalam skill ini.

## Design Brief and Review Gate

Sebelum analisis, buat brief singkat dan minta persetujuan user. Jangan mulai dari asumsi yang belum terlihat.

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
2. Jika `Research needed` tidak kosong, lakukan riset terfokus dan rangkum temuan + sumber sebelum menyusun keputusan.
3. Tampilkan brief dan minta konfirmasi eksplisit (gunakan `ask_user` bila tersedia). Revisi brief bila user memberi feedback.
4. Setelah brief disetujui, lakukan analisis decision-first. Jangan membuat kode executable tanpa opt-in eksplisit.
5. Satu sesi hanya mengerjakan satu prototype question.

## Branch Selection

| Pertanyaan                                               | Branch                                          |
| -------------------------------------------------------- | ----------------------------------------------- |
| "Apakah state machine / reducer ini handle edge case X?" | `LOGIC` — analisis state, transition, invariant |
| "Gimana kalau tampilannya beda?"                         | `UI` — analisis varian layout dan interaction   |

Jika ambigu, default ke `LOGIC` untuk pertanyaan backend/state atau `UI` untuk frontend/layout, lalu tuliskan asumsi di brief.

## Decision-First Workflow

1. **Brief** — tulis question, hypothesis, criteria, context, dan batasan.
2. **Approval** — minta user menyetujui brief.
3. **Research/context review** — baca code, docs, data shape, design system, dan constraint yang relevan.
4. **Compare options** — susun opsi, evidence, trade-off, edge case, accessibility/responsive concern, dan risiko.
5. **Recommend** — pilih `validated`, `inconclusive`, atau `rejected` berdasarkan success criteria.
6. **Capture** — Project mode menulis hasil ke `prototype-decision.md`; Universal mode menampilkannya sebagai pesan chat tanpa membuat file.
7. **Phase exit** — sarankan skill berikutnya, tetapi jangan otomatis menjalankannya.

## Executable Prototype Is Opt-In

Boleh membuat prototype runnable hanya jika user meminta eksplisit, misalnya:

- “buat prototype runnable”
- “buat TUI untuk validasi state”
- “buat variant UI yang bisa dicoba”

Jika diaktifkan:

- tetap throwaway dan nama file/fungsi/route harus mengandung `prototype` atau `_proto`;
- tetap tanpa persistence dan tanpa production code;
- gunakan satu command untuk menjalankan;
- tampilkan state penuh setelah setiap action atau switch variant;
- setelah user review, Project mode menulis decision Markdown; Universal mode menampilkannya di chat; lalu berhenti.

## Capture Format

```markdown
# Prototype Decision — <name>

**Question:** <satu kalimat>
**Hypothesis:** <dugaan sebelum analisis>
**Branch:** LOGIC | UI
**Status:** validated | inconclusive | rejected
**Success criteria:** <sinyal observable>
**Evidence:** <observasi dan sumber, bukan asumsi>
**Options considered:** <opsi + trade-off>
**Decision:** <kesimpulan>
**Date:** <DD-MM-YYYY>

**Validated for real code:** <bagian yang boleh dibawa ke implementasi>
**Rejected/discarded:** <bagian yang dibuang dan alasannya>
**Design requirements carried forward:** <behavior, state, hierarchy, atau constraint>
**Open risks:** <risiko yang belum terjawab atau `none`>
**Suggested next skill:** `implement` | `to-tasks` | `improve-architecture` | `prototype` | `ask-me` | `none`
```

## Phase Exit

Setelah decision capture selesai:

1. Project mode: tampilkan ringkasan keputusan dan path `.workspace/.scratch/<slug>/prototype-decision.md`. Universal mode: tampilkan ringkasan keputusan langsung di chat.
2. Sarankan skill berikutnya berdasarkan hasil:
   - `implement` — keputusan tervalidasi dan siap dibuat;
   - `to-tasks` — keputusan perlu dipecah menjadi task;
   - `improve-architecture` — keputusan membutuhkan refactor/desain teknis;
   - `prototype` — hasil inconclusive dan perlu eksplorasi ulang;
   - `ask-me` — requirement masih ambigu;
   - `none` — tidak ada tindakan lanjutan.
3. Jangan auto-invoke skill tersebut; tunggu pilihan eksplisit user.
4. Setelah capture selesai, berhenti. Universal mode tidak membuat file decision.

Jika success criteria belum terjawab, status wajib `inconclusive`. Jika user menolak hasil, status `rejected` dan alasan penolakan harus dicatat.

## When to Use or Skip

| Situasi                            | Aksi                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| State machine rawan edge case      | Pakai `prototype` decision-first, branch `LOGIC`                |
| API contract belum fix             | Pakai `prototype` untuk membandingkan contract dan failure mode |
| Layout UI belum decided            | Pakai `prototype` decision-first, branch `UI`                   |
| User perlu melihat interaksi nyata | Tanyakan/konfirmasi executable prototype secara eksplisit       |
| Task sederhana, behavior jelas     | Skip — `implement` langsung                                     |
| Refactor code existing             | Skip — `improve-architecture`                                   |
| Persistensi/network real           | Skip — `prototype` tidak menjalankan dependency real            |

## Anti-Patterns

- Langsung membuat kode sebelum brief disetujui.
- Menganggap prototype harus selalu berupa TUI/UI runnable.
- Menambah test, persistence, atau production integration.
- Membuat lebih dari satu pertanyaan/keputusan dalam satu prototype.
- Auto-invoke `implement` atau skill lain setelah decision capture.

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — Validasi desain sebelum implement → `prototype` decision-first, lalu pilih `to-tasks` atau `implement` setelah user menyetujui keputusan.
