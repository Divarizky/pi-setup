---
name: git-commit
description: "Generate conventional commit message dari staged changes, chain ke code-review. Dipanggil oleh user atau route workflow. Jangan trigger untuk git push, git add, atau operasi git lain."
disable-model-invocation: true
---

# Git Commit

Generate conventional commit message dari staged changes, dengan code-review gate sebelum commit.

## Prasyarat

- Repo git (`git rev-parse --git-dir` ok)
- Ada staged changes (`git diff --staged --quiet` exit code 1)
- Tidak ada conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)

Gagal → error jelas, stop. Warning non-blocking: diff >500 lines → "Pertimbangkan split commit."

## Flow Utama

1. Cek prasyarat
2. Baca `git diff --staged`
3. Analisis diff → type, scope, subject
4. Generate 2 versi body (bullet points)
5. Deteksi breaking change (heuristik)
6. Chain ke `code-review`
7. Conditional flow berdasarkan hasil review
8. Tampilkan draft → user pilih versi
9. Konfirmasi final commit
10. Execute `git commit`

## Step 1 — Cek Prasyarat

```bash
git rev-parse --git-dir 2>/dev/null || error "Bukan repo git"
git diff --staged --quiet && error "Tidak ada staged changes. Jalankan git add dulu."
git diff --staged | grep -qE '(<<<<<<<|=======|>>>>>>>)' && error "Ada conflict markers. Resolve dulu."
lines=$(git diff --staged | wc -l); [[ $lines -gt 500 ]] && warn "Diff besar (>500 lines). Pertimbangkan split commit."
```

## Step 2 — Analisis Diff

Input: `git diff --staged --stat` + `git diff --staged`

**Type (heuristik):**
- File baru + export baru → `feat`
- Keyword: fix, handle, guard, patch, resolve → `fix`
- Rename, extract, restructure, move → `refactor`
- `.md`, comment only → `docs`
- `test`, `spec`, `__tests__` → `test`
- Config, deps, build, CI → `chore`
- Whitespace, format, semi-colon → `style`
- Optimasi, cache, lazy load → `perf`
- Default → `chore`

**Scope:** Folder root pertama file berubah (`src/auth/login.ts` → `auth`). ≤3 folder: gabung `auth,api,utils`. >3: `multi` + list di body.

**Subject:** Imperative mood, ≤50 char. Dari perubahan paling signifikan (file baru > export baru > logic change > test > docs).

## Step 3 — Generate Body (2 Versi)

**Versi Lengkap:**
```
<type>(<scope>): <subject>

Perubahan:
- <file>: <detail per fungsi/block>

<BREAKING CHANGE list jika ada>
```

**Versi Ringkas:**
```
<type>(<scope>): <subject>

Perubahan utama:
- <poin utama 1>
- <poin utama 2>

<BREAKING CHANGE list jika ada>
```
(Ringkas: ambil 2-3 poin paling signifikan: file baru, export baru, logic utama berubah)

## Step 4 — Breaking Change Detection (Heuristik)

Cari di staged diff:
- Keyword eksplisit: `BREAKING CHANGE`, `breaking change`, `BREAKING:`, `breaking:`
- Hapus export public: `export function/const/class/interface/type` dihapus
- Signature berubah: required param ditambah/hapus, tipe return berubah
- Hapus file/API public: `.ts`/`.js` dihapus yang punya export
- Enum/const public dihapus: `export const`, `export enum` dihapus
- Rename breaking: file/module rename tanpa alias/redirect

Output: list untuk footer commit.

## Step 5 — Chain ke code-review

Invoke `code-review` dengan staged diff.

**Conditional Flow:**
| Hasil review | Aksi |
|--------------|------|
| CHANGES_REQUESTED / FAIL | 1. Terapkan perbaikan → user edit → balik Step 5 (re-review) 2. Lanjut buat commit message → Step 6 |
| PASS | Tawarkan saran commit message → Step 6 (note "Code review PASS") |

## Step 6 — Tampilkan Draft & Pilih Versi

```
=== Draft Commit ===
Type: feat
Scope: auth
Subject: add OAuth login endpoint

--- Versi Lengkap ---
feat(auth): add OAuth login endpoint

Perubahan:
- src/auth/oauth.ts: add OAuth2 flow, token refresh, error handling
- src/auth/types.ts: add OAuthToken, OAuthConfig types
- tests/auth/oauth.test.ts: add tests for OAuth flow

BREAKING CHANGE: login() signature changed

--- Versi Ringkas ---
feat(auth): add OAuth login endpoint

Perubahan utama:
- src/auth/oauth.ts: implement OAuth2 flow with token refresh
- src/auth/types.ts: add OAuth types

BREAKING CHANGE: login() signature changed

=== Pilih: [1] Lengkap  [2] Ringkas  [e] Edit manual  [c] Cancel ===
```

## Step 7 — Konfirmasi Final Commit

```
Commit dengan pesan di atas? [y/n/edit]
```
- `y` → Step 8
- `n`/`c`/`cancel` → abort
- `e`/`edit` → user edit manual → tanya lagi

## Step 8 — Execute Commit

```bash
git commit -F - <<< "$MESSAGE"
```
Output: `commit <hash> <subject>`

## Auto-Trigger Rules

[Format](../shared/COMMON.md#auto-trigger-rules-format)
| Trigger | Action |
|---------|--------|
| "commit", "buat commit", "pesan commit", "commit message" | Run skill |
| "git push", "git add", "git status", "git log" | No trigger |
| "commit otomatis", "auto commit" | No trigger (selalu konfirmasi) |

## Guardrails

| Kondisi | Action |
|---------|--------|
| Tidak ada staged changes | Error + stop |
| Conflict markers | Error + stop |
| Diff > 500 lines | Warning (non-blocking) |
| Type tidak terdeteksi | Default `chore` + warning |
| Scope > 3 folder | `multi` + list di body |

## Dependensi

- `git` CLI (stdlib)
- Skill `code-review` (chain via [pattern](../shared/COMMON.md#chain-pattern))

## Catatan

- `disable-model-invocation: true` — dipanggil eksplisit atau melalui route workflow
- Selalu `git commit -F - <<< "$MESSAGE"` untuk multi-line body
- Breaking change footer: `BREAKING CHANGE: <deskripsi>` per baris
- Refer [VOCABULARY](../shared/VOCABULARY.md) untuk istilah `Module`, `Interface`, `Seam` di body