# Dev Workflow

Dokumen ini adalah sumber utama alur dan mode kerja skill dev. Detail eksekusi tetap berada di masing-masing `SKILL.md`.

## Mode Kerja

Skill selalu memilih tepat satu mode untuk satu pekerjaan. Mode tidak boleh berubah diam-diam di tengah workflow.

### Universal mode

Mode default jika `.workspace/project-meta.md` tidak tersedia, atau user secara eksplisit meminta workflow tanpa persistence project.

- Konteks utama: percakapan aktif, current directory, file project, dan Git bila tersedia.
- `.workspace/` dan artifact workflow tidak wajib ada.
- Task, PRD, atau handoff ditampilkan di chat terlebih dahulu.
- Jangan membuat atau memperbarui artifact workflow di file.
- Tampilkan artifact dan statusnya di chat sesuai kontrak skill terkait.
- Cocok untuk script, satu file, repo kecil, debugging cepat, dan coding ad-hoc.
- Jika context tidak tersedia, lanjut dengan informasi yang ada dan nyatakan keterbatasannya.

### Project-aware mode

Mode otomatis jika `.workspace/project-meta.md` tersedia dan user tidak meminta Universal mode.

- Konteks: percakapan aktif ditambah `.workspace/context/AGENT.md`, `CONTEXT.md`, dan `ADR.md` bila tersedia.
- Persist state ke `.workspace/` sesuai ownership artifact.
- Gunakan `tasks.md`, `PRD.md`, tracker, dan handoff untuk lintas sesi.
- Artifact yang sudah ada dibaca sebelum membuat atau memperbaruinya.

### Pemilihan mode

1. Skill yang menetapkan Project-aware wajib (`project-migration`) → arahkan ke `setup-workflow` jika marker belum tersedia.
2. User meminta mode tertentu → ikuti permintaan user, kecuali skill memang menetapkan Project-aware wajib.
3. Jika tidak ada permintaan dan marker `.workspace/project-meta.md` tersedia → Project-aware mode.
4. Jika marker tidak tersedia → Universal mode.

Ketiadaan project metadata bukan alasan untuk menghentikan workflow biasa. Skill kompleks yang menetapkan Project-aware wajib boleh menghentikan workflow sampai `setup-workflow` selesai.

## Resolusi Context

Aturan operasional ada di [shared/COMMON.md#context-resolver](shared/COMMON.md#context-resolver). Baca sumber dalam urutan berikut, hanya jika tersedia:

1. Instruksi dan keputusan dari percakapan aktif.
2. File project yang relevan di current directory.
3. Git status, diff, dan history bila tersedia.
4. `.workspace/context/AGENT.md`, `CONTEXT.md`, dan `ADR.md`.
5. Artifact workflow lain yang relevan.

Jangan mengarang isi context yang tidak tersedia. Nyatakan keterbatasannya.

## Alur Utama

```text
ask-me
  ├─ fitur kecil → implement → code-review → git-commit
  ├─ fitur besar → to-prd → to-issues → implement → code-review → git-commit
  ├─ bug sulit → bug-diagnosis → code-review → git-commit
  ├─ desain belum jelas → prototype → to-issues / implement
  ├─ arsitektur → improve-architecture → implement
  └─ migrasi → setup-workflow → project-migration → implement / bug-diagnosis
```

`setup-workflow` adalah persiapan opsional untuk workflow biasa, tetapi wajib sebelum `project-migration`.

## Routing

| Sinyal | Route |
|---|---|
| Intent umum atau ambigu | `ask-me` |
| Fitur kecil, behavior jelas | `implement` |
| PRD/spec | `to-prd` |
| Breakdown task | `to-issues` |
| Error/bug sulit | `bug-diagnosis` |
| Desain belum pasti | `prototype` |
| Refactor/arsitektur | `improve-architecture` |
| Migrasi project | `project-migration` |
| Review diff | `code-review` |
| Commit perubahan | `git-commit` |
| Cek progres | `status` |
| Pindah sesi | `handoff` |

Skill spesifik yang disebut user mengalahkan router `ask-me`.

## Fallback Artifact

Universal mode tidak membuat atau memperbarui artifact workflow di file. Artifact dan statusnya hanya ditampilkan di chat.

| Kebutuhan | Project-aware mode | Universal mode |
|---|---|---|
| Task | `.workspace/.scratch/<slug>/tasks.md` | checklist di chat + status respons |
| PRD | `.workspace/.scratch/<slug>/PRD.md` | draft di chat + status draft/approved |
| Handoff | `.workspace/handoffs/*.md` | ringkasan handoff di chat + Suggested Skills |
| Status | tracker + tasks + handoff | Git + file relevan + percakapan |
| Context | `.workspace/context/*` | inspeksi langsung current directory |
| Migration state | `.workspace/.scratch/migration/*` | tidak tersedia; setup wajib |

Permintaan menulis artifact ke file membutuhkan Project-aware mode; tawarkan `setup-workflow` jika user membutuhkan persistence.

## Ownership Artifact

- `setup-workflow`: project metadata dan context dasar.
- `to-prd`: PRD.
- `to-issues`: tasks baru dan index fitur saat breakdown.
- `implement`: perpindahan Queue/In Progress/Done dan tracking setelah task selesai.
- `status`: read-only.
- `handoff`: dokumen handoff.
- `prototype`: keputusan prototype.

## Completion Contract

Setiap workflow harus menyatakan:

1. perubahan atau artifact yang dibuat;
2. validasi/test yang dijalankan;
3. status pekerjaan;
4. skill berikutnya bila ada;
5. konfirmasi user sebelum aksi irreversible.
