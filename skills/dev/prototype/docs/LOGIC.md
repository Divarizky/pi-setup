# Logic Prototype

Terminal TUI kecil yang user drive langsung — pencet tombol, lihat state berubah. Buat eksplorasi **business logic, state transitions, data shape**. Hal yang keliatan bener di kertas tapi baru terasa salah setelah di-push lewat case nyata.

## Kapan ini bentuk yang tepat

- "State machine ini handle edge case X trus Y?"
- "Data model ini bisa represent case dimana..."
- "Mau rasain dulu gimana API ini dipake sebelum nulis."
- Apapun yang butuh user **pencet tombol dan liat state berubah**.

## Proses

### 1. Tulis question

Sebelum ngoding, tulis satu paragraf: state model apa, question apa. Taruh di README prototype atau komentar teratas file. Logic prototype yang jawab pertanyaan salah = murni buang waktu.

### 2. Pilih bahasa

Pakai bahasa yang sama dengan project. Kalau project gak punya runtime (docs repo), tanya user. Cocokkan convention project — jangan nambah package manager atau runtime baru cuma buat prototype.

### 3. Isolasi logic di portable module

Logic (bagian yang jawab pertanyaan) taruh di belakang interface pure kecil yang bisa di-lift ke real codebase nanti. TUI di sekitarnya throwaway; logic module-nya jangan.

Bentuk tergantung pertanyaan:

- **Pure reducer** — `(state, action) => state`. Cocok kalo action discrete event dan state single value.
- **State machine** — state + transition eksplisit. Cocok kalo "action mana yang legal sekarang?" bagian dari pertanyaan.
- **Pure functions** — transformasi data tanpa implicit state.
- **Class/module dengan method surface jelas** — kalo logic genuinely punya internal state.

Pilih bentuk yang **paling pas buat pertanyaan**, bukan yang paling gampang di-wire ke TUI. Jaga pure: no I/O, no terminal code, no console.log untuk control flow. TUI import dan panggil; gak ada yang flow ke arah sebaliknya.

Ini yang bikin prototype berguna setelah masa hidupnya sendiri — reducer/machine/function yang tervalidasi bisa di-lift ke real module.

### 4. Build TUI terkecil yang surface state

**Lightweight TUI** — tiap tick, clear screen (`console.clear()` / `print("\033[2J\033[H")` / equivalent) dan re-render frame penuh. User selalu lihat satu view stabil, bukan scrollback panjang.

Setiap frame punya 2 bagian, urut ini:

1. **Current state**, pretty-printed dan diff-friendly (satu field per baris, atau formatted JSON). **Bold** buat field name / section header, **dim** buat less important context. Native ANSI escape code fine — `\x1b[1m` bold, `\x1b[2m` dim, `\x1b[0m` reset. Gak perlu library styling kalo belum ada di project.
2. **Keyboard shortcuts** di bottom: `[a] add user  [d] delete user  [t] tick clock  [q] quit`. Bold key, dim description.

Behavior:

1. **Init state** — satu in-memory object. Render frame pertama.
2. **Baca satu keystroke (atau satu line)** — dispatch ke handler yang mutate state.
3. **Re-render** full frame setelah tiap action — jangan append, replace.
4. **Loop sampai quit.**

Satu frame muat di satu layar.

### 5. Satu command buat run

Tambah script ke task runner project (`package.json` scripts, `Makefile`, `justfile`, `pubspec.yaml` tasks, `dart run`). User jalanin `pnpm run <nama>` atau equivalent — gak perlu ingat path.

Kalo project gak punya task runner, tulis command di README prototype.

### 6. Hand over

Kasih user run command. User yang drive; moment menariknya pas user bilang "wait, that shouldn't be possible" — itu bug di **ide**, yang justru tujuan prototype. Kalo user minta action baru, tambahin. Prototype evolves.

### 7. Capture

Setelah prototype jawab question, capture answer, lalu capture prototype sesuai [SKILL.md](SKILL.md). Mapping spesifik logic: validated reducer/machine/function set → lift ke real module (decision, absorbed). TUI shell → throwaway branch sebagai primary source.

## Anti-patterns

- **Jangan tambah test.** Prototype yang butuh test bukan prototype lagi.
- **Jangan wire ke database real.** Pakai in-memory store kalo pertanyaan gak tentang persistence.
- **Jangan generalise.** Gak ada "what if we wanted to support X later."
- **Jangan blur logic dan TUI.** Kalo reducer panggil `console.log` atau terminal escape code, dia gak portable. TUI = thin shell over pure module.
- **Jangan ship TUI shell ke production.** Shell dioptimalkan buat di-drive manual dari terminal. Logic module di belakangnya yang worth keeping.
