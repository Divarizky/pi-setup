# TDD — Vertical Slice Discipline

Default: satu test utama → satu implementasi minimal → ulang. Bukan horizontal
slicing (tulis semua test dulu, baru semua implementasi).

```
BENAR: RED→GREEN test1→impl1, RED→GREEN test2→impl2, ...
SALAH: RED semua test dulu, baru GREEN semua implementasi
```

## Seam — Test Boundary

Test di boundary publik yang sudah disepakati dengan user. Jangan test
di seam internal yang belum dikonfirmasi. Contoh boundary publik:

- pure logic: fungsi atau modul yang menerima input dan mengembalikan output
- UI: interaksi user dan state/hasil yang terlihat
- API: request, response, dan side effect yang dijanjikan
- CLI/event: command atau event masuk dan output/event berikutnya

Prioritaskan critical path + logic kompleks, bukan coverage.

## Anti-Patterns

- **Tautological** — assertion recompute expected value pakai rumus yang
  sama dengan kode. Test pass by construction, gak pernah bisa fail.
  Expected value harus dari sumber independen (literal konkrit, contoh
  dari spec, hasil hitung manual).
- **Implementation-coupled** — mock internal collaborators, test private
  method, query lewat side channel padahal interface publik sudah return
  value. Test break saat refactor, behavior tidak berubah.

## Loop Rules

- **Red before green** — failing test dulu, baru minimal code untuk pass.
  Jangan antisipasi test berikutnya.
- **Validasi RED** — pastikan test gagal karena behavior belum ada atau salah,
  bukan karena syntax error, setup rusak, dependency hilang, atau test tidak
  dapat dijalankan. Jika penyebabnya bukan behavior, perbaiki test/setup dulu.
- **Satu vertical slice per siklus** — default-nya satu seam, satu test utama,
  dan satu implementasi minimal. Beberapa assertion/setup diperbolehkan jika
  masih memverifikasi satu behavior dan tidak memperluas slice.
- **Refactoring bukan bagian loop** — dalam workflow ini refactor ditangani
  di `code-review` agar siklus TDD tetap fokus pada behavior. Jangan menunda
  perbaikan correctness hanya karena refactoring ditunda.

## Other

Mode dan context:

- Project: gunakan istilah dari `.workspace/context/PROJECT.md` jika tersedia.
- Universal: gunakan istilah dari percakapan, source code, atau spec yang user
  berikan; jangan membuat context artifact.

Tanda test buruk: test gagal saat refactor padahal behavior tidak berubah,
atau test tidak pernah terbukti gagal karena alasan behavior.
