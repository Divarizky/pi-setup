---
name: bug-diagnosis
description: "Diagnosis loop disiplin 6-phase untuk bug sulit (reproduce, minimise, hypothesise, instrument, fix, regression-test). Dipanggil oleh user atau route workflow. Jangan gunakan untuk fix sepele — arahkan ke implement. Heavy — konfirmasi user dulu sebelum jalan."
disable-model-invocation: true
---

# Bug Diagnosis

Disiplin untuk bug sulit. Skip phase hanya kalau ada justifikasi eksplisit — jangan lompat ke fix tanpa alasan jelas.

## Prerequisites

[Prerequisites](../shared/COMMON.md#prerequisites) — heavy, setup membantu diagnosis lebih akurat tetapi tidak wajib. Universal mode tetap berjalan tanpa artifact workflow.

## Pre-Diagnosis Confirmation

> "Bug ini butuh diagnosis 6-phase. Lanjut? (y/n)"

- **y** → Phase 1
- **n/tidak respons** → stop. Sarankan `ask-me` (diskusi) atau `implement` (fix trivial)

## Before Starting

Gunakan Context Resolver dari `../shared/COMMON.md`. Baca `.workspace/context/PROJECT.md`, `CONTEXT.md`, dan `ADR.md` hanya jika tersedia. Universal mode memakai percakapan, file project, dan Git yang tersedia; jangan membuat context artifact.

## Phase 1 — Reproduce

**Tight loop = skill ini.** Cari sinyal pass/fail cepat, deterministik, repeatable. Tanpa sinyal jelas → tidak ketemu akar masalah.

**Opsi sinyal (prioritas):**

1. Test di seam menjangkau bug (unit/integration/UI)
2. API/HTTP repro (curl, script, replay request)
3. Log/grep (logcat, console, crash trace)
4. CLI diff (output before/after)
5. Minimal isolated project
6. `git bisect run`
7. Differential run (2 env: staging/prod, 2 device, 2 browser)
8. Fuzz/stress (intermittent/race)
9. Screenshot/snapshot diff (UI regression)
10. Manual step-by-step (last resort, catat tiap langkah)

**Non-deterministic** (repro <100%): target tingkatkan **reproduction rate** — loop trigger, paralelkan, tambah stress, incremental complexity.

**Bukan bug** (expected behavior, env/config mismatch): stop, jelaskan temuan ke user, tutup diagnosis.

## Phase 2 — Minimise

Perkecil reproduksi ke elemen minimal yang masih memicu bug. Memperkecil ruang hipotesis (Phase 3) dan menjadi dasar regression test (Phase 5–6).

**Seam criteria**: definisi good/bad seam lihat [Vocabulary](../shared/VOCABULARY.md#architecture).

Bad seam → 2 kasus:

1. **Seam minimal untuk debug bug ini** — extract method kecil, buat interface tipis (1-2 method), parameterize dependency. **Wajib buat sekarang**.
2. **Seam arsitektur penuh** — port/adapter baru, restrukturisasi modul. **Bukan ranah bug fix**. Catat, serahkan ke `improve-architecture`.

## Phase 3 — Form Hypotheses

Buat daftar hipotesis, ranking paling mungkin. Tiap hipotesis wajib punya **prediksi konkret** — tidak bisa nyatakan prediksi = tebakan, buang/pertajam.

Prioritaskan hipotesis dari perubahan terbaru: `git log`/diff sejak bug pertama muncul.

Tampilkan ranking ke user → user sering re-rank dari konteks domain. No response → lanjut pakai ranking sendiri.

## Phase 4 — Instrument

Tiap probe map ke prediksi spesifik Phase 3. Ubah satu variabel per waktu.

**Escape hatch**: max **3 siklus** hypothesis→instrument→gagal → stop, tanya user:

> "3 hipotesis diuji, akar belum ketemu. Lanjut hipotesis baru, atau handoff ke agent/sesi lain?"

- Lanjut → reset counter (maks **2 ronde total**; habis → wajib handoff)
- Handoff → arahkan ke `handoff`, simpan progres (phase terakhir, hipotesis eliminated, repro steps)

**Prioritas alat**: Debugger/REPL (1 breakpoint > 10 log) → Targeted log di titik beda hipotesis (tag prefix unik `[DEBUG-xxxx]` untuk cleanup).

## Phase 5 — Fix

Ubah minimised repro (Phase 2) jadi failing test di seam tepat. Lihat gagal → fix → lolos → jalankan skenario original (bukan minimised) untuk konfirmasi penuh.

## Phase 6 — Regression Test

Test Phase 5 tetap di suite — cegah regress. Catat hipotesis benar di commit message.

**Maintenance**: test flaky/stale setelah refactor → `improve-architecture` health check.

## After Completion

Tanya: "Apa mencegah bug ini dari awal?" Jawab melibatkan arsitektur (no good seam, coupling tersembunyi) → sarankan `improve-architecture` terpisah.

Universal mode: tampilkan fase terakhir, akar masalah, perubahan, regression test, dan status diagnosis di respons. Project mode: update artifact hanya sesuai kontrak workflow yang tersedia.

## AFK

Tidak jalan otomatis (`disable-model-invocation: true`) — selalu butuh invoke user atau route eksplisit. Rekomendasi `improve-architecture` saat sesi berjalan → catat di commit message/log, berhenti; user invoke manual nanti.

## Other Suggested Skills

[Workflow](../WORKFLOW.md) — `bug-diagnosis` temuan arsitektur → `improve-architecture`.
