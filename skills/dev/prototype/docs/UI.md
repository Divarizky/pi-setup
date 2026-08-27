# UI Prototype

Branch `UI` menjawab satu pertanyaan tentang layout, hierarchy, interaction, density, accessibility, atau responsive behavior. **Default-nya decision-first:** bandingkan opsi dan susun decision capture (file di Project mode, pesan chat di Universal mode); jangan membuat screen/route/variant code tanpa permintaan eksplisit.

## When This Is the Right Shape

- “Layout mana yang membuat action utama lebih mudah ditemukan?”
- “Dashboard ini lebih baik memakai sidebar atau command surface?”
- “Bagaimana hierarchy informasi pada settings screen?”
- “Trade-off responsive dan accessibility dari beberapa struktur UI apa?”

## Decision-First Process

1. **Set host context** — identifikasi screen/route existing, data, auth, navigation, dan design system.
2. **Tetapkan evaluation criteria** — hierarchy, discoverability, keyboard/focus, contrast, accessibility, responsive behavior, dan density.
3. **Susun maksimal 3 opsi struktural** — bedakan layout/hierarchy/primary affordance, bukan sekadar warna.
4. **Bandingkan trade-off** — catat apa yang mudah/sulit ditemukan, constraint breakpoint, focus order, dan risiko implementasi.
5. **Pilih status** — `validated`, `inconclusive`, atau `rejected` berdasarkan criteria, bukan selera visual semata.
6. **Capture decision** — Project mode menulis `.workspace/.scratch/<slug>/prototype-decision.md`; Universal mode menampilkan decision capture di chat tanpa membuat file.

Contoh tabel evaluasi:

| Opsi    | Hierarchy | Discoverability | Accessibility     | Responsive risk | Decision |
| ------- | --------- | --------------- | ----------------- | --------------- | -------- |
| Sidebar | kuat      | baik            | focus order jelas | medium          | kandidat |

## Optional Executable Mode

Hanya gunakan jika user meminta variant UI runnable secara eksplisit. Setelah disetujui:

- default maksimal 3 varian yang berbeda secara struktural;
- lebih baik mount pada existing screen/route;
- gunakan switcher berbasis state, bukan URL;
- switcher punya mouse dan keyboard navigation;
- hidden dari production/debug gate;
- data fetching dan auth tetap memakai host context;
- varian read-only, throwaway, tanpa backend mutation;
- setelah user review, Project mode menulis decision Markdown; Universal mode menampilkannya di chat; lalu hapus/isolasi shell throwaway.

## Output yang Diharapkan

Decision capture (file di Project mode, pesan chat di Universal mode) harus memuat:

- question, hypothesis, dan host context;
- evaluation criteria;
- opsi dan trade-off struktural;
- evidence dari review/user feedback;
- decision dan rejected alternatives;
- design requirements untuk real code;
- open risks;
- suggested next skill.

## Phase Exit

Setelah decision capture selesai, sarankan:

- `implement` jika layout tervalidasi;
- `to-tasks` jika perlu dipecah;
- `improve-architecture` jika perubahan menyentuh struktur UI/data;
- `prototype` jika hasil inconclusive;
- `ask-me` jika requirement atau host context ambigu;
- `none` jika tidak ada tindakan lanjutan.

Jangan menjalankan skill berikutnya otomatis.

## Anti-Patterns

- Langsung membuat tiga varian code sebelum brief disetujui.
- Varian hanya berbeda warna atau spacing.
- Membuat route kosong padahal ada existing screen yang bisa menjadi host.
- Menghubungkan prototype ke mutation/backend nyata.
- Mempromosikan varian ke production tanpa decision capture dan user approval.
