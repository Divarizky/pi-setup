# TDD — Vertical Slice Discipline

Satu test → satu implementasi minimal → ulang. Bukan horizontal slicing
(tulis semua test dulu, baru semua implementasi).

```
BENAR: RED→GREEN test1→impl1, RED→GREEN test2→impl2, ...
SALAH: RED semua test dulu, baru GREEN semua implementasi
```

## Seam — batas test

Test di interface publik yang sudah disepakati dengan user. Jangan test
di seam yang belum dikonfirmasi. Prioritaskan critical path + logic kompleks,
bukan coverage.

## Anti-patterns

- **Tautological** — assertion recompute expected value pakai rumus yang
  sama dengan kode. Test pass by construction, gak pernah bisa fail.
  Expected value harus dari sumber independen (literal konkrit, contoh
  dari spec, hasil hitung manual).
- **Implementation-coupled** — mock internal collaborators, test private
  method, query lewat side channel padahal interface publik sudah return
  value. Test break saat refactor, behavior tidak berubah.

## Aturan loop

- **Red before green** — failing test dulu, baru minimal code untuk pass.
  Jangan antisipasi test berikutnya.
- **Satu slice per siklus** — satu seam, satu test, satu implementasi.
- **Refactoring bukan bagian loop** — refactor milik `code-review`, bukan
  siklus RED→GREEN.

## Lainnya

Nama test & interface pakai istilah dari `.workspace/context/AGENT.md`.
Tanda test buruk: test gagal saat refactor padahal behavior tidak berubah.
