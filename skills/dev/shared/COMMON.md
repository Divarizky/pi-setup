# Shared Patterns

Common utilities referenced by all dev skills. Import via markdown link: `[Prasyarat](../shared/COMMON.md#prasyarat)`.

---

## Prasyarat

`.workspace/project-meta.md` bersifat opsional.

- User meminta mode tertentu → ikuti permintaan user.
- Tidak ada permintaan dan marker tersedia → gunakan **project-aware mode**; baca context/artifact yang tersedia.
- Marker tidak tersedia → gunakan **universal mode**; lanjut dengan context dari percakapan, current directory, file project, dan Git bila tersedia.
- Dalam Universal mode, artifact workflow tidak ditulis ke file; tampilkan artifact dan statusnya di chat sesuai kontrak skill.
- Aturan ini berlaku untuk PRD, task, handoff, tracking, dan artifact workflow lain; tidak membatasi perubahan source code yang memang diminta user.
- Jangan hard-stop hanya karena workspace belum ada, kecuali skill menetapkan Project-aware mode wajib.

`setup-workflow` adalah pengecualian eksplisit: skill ini memang membuat `.workspace/` untuk mengaktifkan penyimpanan context project-aware. `project-migration` adalah skill kompleks yang wajib memakai setup tersebut. Jika user membutuhkan artifact lintas sesi, tawarkan `setup-workflow`; jangan menggantinya dengan penulisan file dalam Universal mode.

Detail mode, fallback artifact, dan ownership ada di [WORKFLOW.md](../WORKFLOW.md).

---

## Context Resolver

Semua skill yang membutuhkan context harus mengikuti resolver ini. Jangan mengasumsikan file context tersedia.

### 1. Tentukan Work Root

```text
Jika `git rev-parse --show-toplevel` berhasil:
  work_root = Git root
Jika command gagal atau folder bukan repo Git:
  work_root = current directory
```

Gunakan `work_root` untuk mencari file project. Jangan scan seluruh filesystem.

### 2. Tentukan Mode

Ikuti aturan [WORKFLOW.md](../WORKFLOW.md#pemilihan-mode):

- User meminta mode tertentu → ikuti permintaan tersebut.
- Marker `.workspace/project-meta.md` tersedia → Project-aware mode.
- Marker tidak tersedia → Universal mode.

### 3. Baca Sumber Secara Kondisional

Gunakan sumber sesuai jenis informasinya, bukan satu urutan global:

- **Instruksi user saat ini** — prioritas tertinggi untuk tujuan dan aksi sesi ini.
- **ADR** — constraint dan keputusan arsitektur final; jangan ubah tanpa alasan eksplisit.
- **AGENT/CONTEXT** — vocabulary, konvensi, pola, dan detail project.
- **File project dan Git** — fakta aktual tentang kode, perubahan, dan struktur.
- **Artifact workflow** — status PRD, task, handoff, dan keputusan yang sudah dipersist.

Aturan baca:

- `read_if_exists(path)`: jika ada dan readable, baca; jika tidak ada, skip tanpa error; jika ada tapi corrupt/tidak readable, laporkan dan jangan overwrite diam-diam.
- Path relatif selalu di-resolve dari `work_root`.
- Jangan membuat file context hanya karena file tersebut tidak ada.
- Jika context yang dibutuhkan tidak tersedia, nyatakan keterbatasannya dan lanjutkan dengan sumber yang ada bila aman.
- Instruksi user saat ini mengalahkan asumsi context lama, kecuali bertentangan dengan constraint keamanan atau aksi yang memerlukan konfirmasi.

### 4. Catat Context yang Dipakai

Catat ringkasan ini secara internal untuk keputusan biasa:

```text
Mode: Universal | Project-aware
Work root: <path relatif atau nama repo>
Sources: <daftar file/sumber yang benar-benar dibaca>
Missing optional context: <jika ada>
```

Tampilkan ringkasan hanya jika context hilang, sumber konflik, user meminta, atau workflow menghasilkan handoff/keputusan penting. Jangan menulis log tambahan ke project kecuali skill memang memiliki artifact output.

---

## Subagent Detection (Once Per Session)

```markdown
### Deteksi Kapabilitas Subagent (sekali per sesi)

Cek apakah agent bisa spawn subagent (`subagent_spawn` tersedia, platform tidak batasi):
- `subagent_supported = true` → task `Parallel: yes` bisa dieksekusi paralel
- `false` → semua task sequential, `Parallel: yes` diabaikan
- Cek SEKALI per sesi, jangan ulang tiap task.
```

---

## Escape Hatch Template

```markdown
### Escape Hatch

Setelah maks **3 siklus gagal** (hypothesis→instrument→gagal, atau RED→GREEN stuck):
1. Stop loop
2. Tanya user: "3 siklus gagal. Opsi: (a) lanjut coba baru, (b) minta bantuan, (c) batalkan/handoff"
3. User pilih → reset counter (a), handoff (b), atau abort (c)
4. Jangan loop forever.
```

---

## Chain Pattern (Manual Invoke)

```markdown
### Chain ke Skill Lain

Skill target `disable-model-invocation: true` → tidak auto-invoke.
**Baca `target/SKILL.md`, jalankan Step 1-N manual** di sesi yang sama.
Pass context via inline text (spec, diff range, done criteria) — bukan file path.
```

---

## Auto-Trigger Rules Format

```markdown
## Auto-Trigger Rules

| Trigger frase | Action |
|---------------|--------|
| "keyword 1", "keyword 2" | Run skill |
| "other keyword" | No trigger (reason) |
```

---

## Redaction Patterns (Handoff)

```markdown
## Redaction Patterns

Scan & redact sebelum tulis handoff:
- `sk-...` (API key 30+ char)
- `AKIA...` (AWS access key)
- `ghp_...`, `gho_...`, `github_pat_...` (GitHub token)
- `-----BEGIN.*KEY-----` (private key)
- `Bearer [a-zA-Z0-9\-_]+` (JWT)
- `password=`, `passwd=`, `secret=` inline
- Email → `user@***`
- Internal IP `10.`, `172.16-31.`, `192.168.` → redact
- Env vars `DATABASE_URL`, `REDIS_URL`, `AWS_SECRET_KEY` → redact value

Kalau ragu: tanya user. Contoh: "Ada info sensitif yang perlu diredact?"
```

---

## Routing dan Cross-Reference

Routing utama dan saran skill ada di [WORKFLOW.md](../WORKFLOW.md).

---

## Vocabulary Reference

See [VOCABULARY.md](./VOCABULARY.md) for: Module, Interface, Depth, Seam, Adapter, Locality, ADR Filter.
