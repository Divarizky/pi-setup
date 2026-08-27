# Logic Prototype

Branch `LOGIC` menjawab satu pertanyaan tentang business logic, state transition, data shape, atau invariant. **Default-nya decision-first:** analisis dan susun decision capture (file di Project mode, pesan chat di Universal mode); jangan membuat TUI atau kode executable.

## When This Is the Right Shape

- “State machine ini menangani edge case X lalu Y?”
- “Data model ini bisa merepresentasikan kasus tertentu?”
- “API contract mana yang paling aman?”
- “Action mana yang legal pada state tertentu?”

## Decision-First Process

1. **Map existing context** — baca reducer/state machine, event, model, caller, dan persistence boundary yang relevan.
2. **Define invariant** — tulis state yang valid, transition legal, dan kondisi terminal.
3. **Enumerate scenarios** — happy path, failure, retry, cancellation, timeout, duplicate, restart, dan dependency edge case sesuai pertanyaan.
4. **Compare options** — gunakan tabel transition/data shape dengan evidence dan trade-off.
5. **Check success criteria** — pastikan observasi dapat membedakan hypothesis benar atau salah.
6. **Capture decision** — Project mode menulis `.workspace/.scratch/<slug>/prototype-decision.md`; Universal mode menampilkan decision capture di chat tanpa membuat file.

Contoh tabel analisis:

| Current state | Action/event | Expected next state | Invariant                | Open risk       |
| ------------- | ------------ | ------------------- | ------------------------ | --------------- |
| `running`     | `timeout`    | `needs-decision`    | partial output preserved | retry semantics |

## Optional Executable Mode

Hanya gunakan jika user meminta prototype runnable secara eksplisit. Setelah disetujui:

- pisahkan logic ke reducer/state machine/function pure;
- TUI hanya menjadi shell tipis untuk dispatch action;
- state in-memory dan throwaway;
- setiap action menampilkan full state;
- satu command untuk menjalankan;
- jangan menambah test, persistence, atau production integration;
- setelah user review, Project mode menulis decision Markdown; Universal mode menampilkannya di chat; lalu berhenti.

## Output yang Diharapkan

Decision capture (file di Project mode, pesan chat di Universal mode) harus memuat:

- question dan hypothesis;
- state/data model yang dibandingkan;
- transition table dan edge case evidence;
- invariant yang terbukti atau gagal;
- decision: `validated`, `inconclusive`, atau `rejected`;
- requirements yang dibawa ke real code;
- open risks;
- suggested next skill.

## Phase Exit

Setelah decision capture selesai, sarankan:

- `implement` jika logic tervalidasi;
- `to-tasks` jika perlu dipecah;
- `improve-architecture` jika ada refactor struktural;
- `prototype` jika evidence belum cukup;
- `ask-me` jika requirement ambigu;
- `none` jika tidak ada tindakan lanjutan.

Jangan menjalankan skill berikutnya otomatis.

## Anti-Patterns

- Membuat TUI sebelum decision question dan brief disetujui.
- Membuat logic prototype yang bergantung pada terminal atau I/O.
- Menambah test/persistence sehingga prototype berubah menjadi fitur.
- Menyelesaikan beberapa state machine dalam satu prototype.
- Menganggap hasil inconclusive sebagai keputusan final.
