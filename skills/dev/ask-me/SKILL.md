---
name: ask-me
description: 'Jalur utama + grill. Auto-trigger saat user bilang: "gimana caranya", "mau nambah X", "bantu aku Y", "lanjutin kerjaan", atau intent ambigu. Route ke skill tepat berdasarkan Step 1 table. Untuk fitur baru, grill 3-5 pertanyaan dulu sebelum routing. Jangan trigger kalau user sudah sebut skill eksplisit.'
model-invocation: enabled
---

# Ask Me — Grilling and Routing

Asisten grill umum yang juga menjadi router skill dev. Untuk permintaan eksplisit atau intent ambigu, mulai dari ide kasar user dulu; setelah arahnya jelas, lanjutkan grill yang sesuai atau arahkan ke skill dev.

## Prerequisites

[Prerequisites](../shared/COMMON.md#prerequisites) — deteksi mode sesuai `../WORKFLOW.md`. Dalam Universal mode, lanjut tanpa membuat artifact workflow; catat mode dan keterbatasan context di respons bila relevan.

## Main Path

Baca `../WORKFLOW.md` hanya ketika jawaban mengarah ke pekerjaan coding/project.

1. **General Grill** — pahami ide kasar, tujuan, dan bentuk bantuan yang diinginkan
2. **Dev Grill/Router** — jika arahnya coding/project, baca workflow lalu arahkan ke skill dev
3. **Action Options** — tawarkan beberapa langkah berikutnya; boleh berupa tindakan biasa tanpa skill dev

General Grill tidak dibatasi pada project, coding, atau domain tertentu.

### Off-Ramps

- Bug → `bug-diagnosis`
- Merge conflict → `merge-conflict`
- Arsitektur → `improve-architecture` (catat, jangan perbaiki sekarang)
- Sesi panjang → `handoff`
- Migrasi project → `setup-workflow` lalu `project-migration` (wajib Project)
- Desain ragu → `prototype`

## Step 1 — Detect Intent

Urutan prioritas:

1. User meminta **Grill Dalam** secara eksplisit → masuk ke Grill Dalam; jika topik belum diberikan, tanyakan ide kasar terlebih dahulu.
2. User memanggil `ask-me`/meminta dibantu tanpa tujuan jelas → **General Grill**.
3. User menyebut tujuan coding/project dengan jelas → **Dev Router**.
4. Intent ambigu atau cocok dengan lebih dari satu arah → **General Grill** dulu.

| Sinyal                                                                      | Jalur                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| "tambah fitur baru", "buat halaman baru", "mau bikin X" — no breakdown      | → **Step 2 (Grill)**                                 |
| "kerjakan task X", "lanjut task berikutnya", "implement task dari tasks.md" | `implement`                                          |
| "error", "bug", "crash", "gagal", "lambat", stack trace                     | `bug-diagnosis`                                      |
| "resolve conflict", "ada conflict", "CONFLICT", "konflik merge"             | `merge-conflict`                                     |
| "buat requirements", "buat PRD", "dokumentasikan fitur ini", "tulis spec"   | `to-requirements`                                    |
| "pecah jadi task", "breakdown plan ini", "buat daftar task"                 | `to-tasks`                                           |
| "refactor", "kode susah dibaca", "modul berantakan" (same project)          | `improve-architecture`                               |
| "migrasi", "pindah project lama", "port ke project baru"                    | `setup-workflow` → `project-migration`               |
| "review perubahan ini", "cek diff sejak X", "vet sebelum commit"            | `code-review`                                        |
| "handoff", "compact sesi ini", "lanjut di sesi lain"                        | `handoff`                                            |
| "gua lagi di mana", "status", "lagi ngerjain apa"                           | `status`                                             |
| "coba explore", "test ide", "spike", "prototype", "ragu desain"             | `prototype` (tanya: logic/state atau visual/layout?) |
| Ambigu, >1 skill match                                                      | **General Grill** dulu                               |
| "grill dalam", "analisis mendalam", "bedah ide ini"                         | **Grill Dalam** — tanyakan topik/ide jika belum ada  |
| User memanggil `ask-me` secara eksplisit                                    | **General Grill** — tanyakan ide kasar dulu          |
| User butuh persistence lintas sesi                                          | Tawarkan `setup-workflow`                            |
| Migrasi project                                                             | `setup-workflow` → `project-migration`               |

Jika intent sudah jelas coding/project, lewati General Grill dan masuk ke Dev Grill atau langsung ke skill spesifik. Jika rekomendasi sudah jelas, lanjut ke Step 4 (Konfirmasi).

## Step 2 — General Grill

Jika user memanggil `ask-me` secara eksplisit atau intent belum jelas, gunakan selection UI `ask_user` sebagai pertanyaan pembuka. Tampilkan tepat **3 opsi dari model**; extension otomatis menambahkan opsi ke-4 untuk jawaban bebas.

```json
{
  "question": "Mau mulai dari mana?",
  "options": [
    { "label": "Bikin atau ubah sesuatu" },
    { "label": "Cari tahu sesuatu" },
    { "label": "Bikin rencana" }
  ]
}
```

Aturan selection awal:

- Jangan menambahkan opsi free-form sendiri; opsi ke-4 selalu disediakan extension.
- Gunakan hanya saat user belum menyebut tujuan atau skill yang spesifik.
- Untuk layout compact, gunakan tiga label pendek tanpa deskripsi; UI menambahkan free-form sebagai opsi ke-4.
- Perlakukan pilihan user sebagai jawaban pertama General Grill, bukan sebagai keputusan final.
- Jika UI tidak tersedia, fallback ke pertanyaan plain text yang sama.
- Jika user membatalkan, jangan berasumsi atau mengulang selection tanpa konteks baru.

Jangan menebak domain atau langsung memilih skill sebelum user menjawab. Setelah jawaban pertama:

1. Ringkas pemahaman sementara dalam 1-2 kalimat.
2. Klasifikasikan arah sementara: coding/project, belajar, riset, bisnis, administrasi, keputusan, atau lainnya.
3. Ajukan pertanyaan lanjutan yang menyesuaikan arah tersebut, maksimal 3-5 pertanyaan total.
4. Jika arahnya coding/project, lanjut ke **Dev Grill** di bawah.
5. Jika bukan coding/project, tetap di General Grill dan tawarkan 2-3 opsi tindakan konkret; opsi boleh berupa rencana, checklist, riset, draft, atau langkah lain tanpa skill dev.

Output General Grill:

```text
Arah sementara: <kategori>
Tujuan: <yang ingin dicapai>
Opsi berikutnya:
1. <aksi>
2. <aksi>
3. <aksi>
Status: ready-for-choice | needs-clarification
```

Tidak ada file atau artifact workflow yang dibuat oleh General Grill.

## Step 3 — Deep Grill / Dev Grill

Permintaan eksplisit **Grill Dalam** melewati General Grill setelah topik tersedia. Untuk topik non-dev, gunakan pertanyaan domain, tujuan, constraint, dependency, dan opsi tindakan yang relevan; jangan memaksakan routing ke skill dev. Untuk topik coding/project, lanjutkan dengan Dev Grill berikut:

Gunakan Context Resolver. Baca `PROJECT.md`, `CONTEXT.md`, dan `ADR.md` hanya jika tersedia. Dalam Universal mode, gunakan context percakapan dan file project relevan; jangan membuat atau memperbarui context artifact. Tanya satu per satu, skip yang jelas:

1. **Behavior** — "Apa yang harus terjadi dari sisi user?"
2. **Terminologi** — "Istilah baru atau sinonim existing?" — validasi vs PROJECT.md
3. **Scope** — "Satu modul atau lintas modul?"
4. **Constraint** — "Batasan teknis/bisnis?"
5. **Priority** — "MUST (critical path) atau NICE?"

Istilah baru → Project mode: update file inline mengikuti **Aturan Split** di `setup-workflow`. Universal mode: tampilkan definisi/keputusan di chat dan catat statusnya di respons; jangan menulis context artifact. Bentrok → klarifikasi sinonim.

### Deep Grill (large scope / ambiguous / new project)

**Mode Sharpen** (existing project, scope besar/ambigu):

1. Domain model — "Istilah kunci? Bentrok PROJECT.md?"
2. Keputusan arsitektur — "Hard to reverse?" → ADR kalau lolos 3 filter
3. Validasi kode — "Klaim cocok kode existing?" → eksplorasi codebase
4. Dependency — "Bergantung ke apa? Ada seam?"
5. Test — "Punya test? Butuh characterization test?"

**Mode Bangun Domain** (new project atau domain yang belum jelas):

- Interview loop: 1 pertanyaan/giliran, rekomendasi jawaban
- **Max 15 pertanyaan** → tanya "Lanjut? (y/n)"
- Fokus: terminology inti, konsep, hubungan entitas, batasan sistem
- Project mode: output ke PROJECT.md (quick) + CONTEXT.md (detail) + ADR pertama — ikuti **Aturan Split**
- Universal mode: tampilkan hasil domain model di chat dan catat statusnya di respons; jangan membuat file

Aturan kedua mode: eksplorasi codebase dulu kalau bisa jawab. Tulis ke PROJECT.md/CONTEXT.md hanya dalam Project mode; Universal mode tetap chat-only.

### Determine Route

| Scope                              | Rekomendasi                                  |
| ---------------------------------- | -------------------------------------------- |
| Kecil (1 modul), behavior jelas    | `implement` langsung                         |
| Besar (lintas modul)               | Grill dalam → `to-requirements` → `to-tasks` |
| Banyak ambigu / desain belum solid | Grill dalam → `prototype`                    |
| State machine / logic complex      | `prototype` LOGIC                            |
| UI layout belum decided            | `prototype` UI                               |

## Step 4 — Confirm

"Ini masuk kategori [skill/rekomendasi], lanjut?" — user konfirmasi/koreksi. Untuk General Grill, konfirmasi berupa pilihan dari 2-3 opsi tindakan; tidak perlu memilih skill dev.

## Step 5 — Redirect

Arahkan ke skill terpilih: "Ini masuk `implement`, lanjut di sana."

Dalam respons routing, sertakan bila relevan:

```text
Mode: Universal | Project
Route: <skill berikutnya>
Context: <sumber utama yang tersedia>
Persistence: chat-only | .workspace
Status: routed | waiting-confirmation
```

## Notes

**Multi-Agent**: jika `.workspace/project-meta.md` tersedia, gunakan state Project yang sudah dipersist. Tanpa marker, lanjut Universal mode dan jangan menganggap context tersedia di agent/sesi berikutnya.

## Tips

- User sebut skill eksplisit → invoke langsung, skip `ask-me`
- Untuk selection pembuka General Grill, kirim tepat 3 opsi model tanpa opsi free-form; opsi ke-4 berasal dari `ask_user`.
- Cek mode sebelum route. Tawarkan `setup-workflow` hanya untuk persistence lintas sesi atau route yang memang wajib Project.

## Session Rules

| Jenis                 | Aturan                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Single-session        | Grill + implement kecil selesai 1 sesi                                                                                       |
| Multi-session         | Grill dalam + to-requirements + to-tasks: 1 sesi, no compact tengah; handoff sebelum tutup; implement per task di sesi fresh |
| Bug di tengah feature | 1. handoff feature context 2. bug-diagnosis terpisah 3. handoff fix 4. balik ke feature                                      |
| Compact vs Handoff    | Normal → lanjut; Thread sama penuh → compact; Ganti task/phase → handoff; Tengah phase → handoff (no compact)                |

## Auto-Trigger Rules

`model-invocation: enabled`. Rules:

- User sebut skill dev selain `ask-me` → no trigger; invoke skill tersebut langsung
- User memanggil `ask-me` eksplisit → mulai General Grill dengan pertanyaan ide kasar
- Sinyal match skill spesifik → route ke skill tersebut secara eksplisit
- Sinyal umum/ambigu → `ask-me` ambil
