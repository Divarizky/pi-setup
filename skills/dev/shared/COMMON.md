# Shared Patterns

Common utilities referenced by all dev skills. Import via markdown link: `[Prasyarat](../shared/COMMON.md#prasyarat)`.

---

## Prasyarat

```markdown
## Prasyarat

`.workspace/project-meta.md` idealnya sudah ada (`setup-workflow` sudah jalan).
Belum ada → tawarkan `setup-workflow`, izinkan lanjut dengan warning:
"tanpa setup, context terbatas — AGENT.md/CONTEXT.md/ADR.md tidak tersedia".
Jangan hard-stop.
```

**Exception**: `implement`, `to-prd`, `to-issues` — hard-check, arahkan ke setup, stop.

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

Kalau ragu: tanya user "Ada info sensitif yang perlu diredact?"
```

---

## Cross-Reference Skill Table (Saran Skills Lain)

```markdown
## Saran Skills Lain

| Situasi | Skill |
|---------|-------|
| Fitur baru, ide ambigu | `ask-me` (grill dulu) |
| Sudah punya PRD, butuh task | `to-issues` |
| Sudah punya task, eksekusi | `implement` |
| Bug sulit, butuh diagnosis | `bug-diagnosis` |
| Review perubahan sebelum commit | `code-review` → `git-commit` |
| Arsitektur butuh deepening | `improve-architecture` |
| Migrasi project lama → baru | `project-migration` |
| Validasi desain sebelum implement | `prototype` (LOGIC/UI) |
| Butuh snapshot posisi kerja | `status` |
| Ganti sesi/device, bawa konteks | `handoff` |
| Setup pertama kali repo | `setup-workflow` |
```

---

## Vocabulary Reference

See [VOCABULARY.md](./VOCABULARY.md) for: Module, Interface, Depth, Seam, Adapter, Locality, ADR Filter.