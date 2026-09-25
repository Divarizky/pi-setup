# Logic Prototype

Branch `LOGIC` menjawab satu pertanyaan tentang business logic, state transition, data shape, atau invariant dengan **demo interaktif runnable mandiri**. Simpan artifact di `.workspace/prototypes/<slug>/`; jangan mengubah source atau route aplikasi. Hasil utamanya adalah kesempatan bagi user untuk mencoba skenario dan melihat apakah behavior model sesuai harapan.

Jika pertanyaannya tentang tampilan, gunakan [UI.md](UI.md).

## Kapan Dipakai

- “State machine ini menangani edge case X lalu Y?”
- “Data model ini bisa merepresentasikan kasus tertentu?”
- “API contract mana yang paling aman?”
- “Action mana yang legal pada state tertentu?”
- “Saya ingin melihat apa yang terjadi ketika rangkaian action ini dijalankan.”

## Alur Logic

### 1. Brief dan approval

Ikuti brief dan approval gate di `../SKILL.md`. Tulis satu pertanyaan yang hendak dijawab, hypothesis, dan hasil yang bisa diamati. Setelah brief disetujui, approval tersebut sudah mengizinkan pembuatan demo runnable; jangan meminta approval runnable tambahan.

### 2. Modelkan logic yang diuji

1. Baca reducer/state machine, event, model, caller, dan persistence boundary yang relevan.
2. Tulis invariant, state valid, transition legal, serta kondisi terminal yang relevan dengan pertanyaan.
3. Pilih bentuk logic yang paling tepat: pure reducer, state machine, pure functions, atau class/module dengan method surface yang jelas.
4. Jaga logic demo terpisah dari halaman: logic tidak membaca DOM dan tidak bergantung pada handler tombol.

### 3. Buat demo HTML interaktif

Buat `.workspace/prototypes/<slug>/index.html` sebagai satu file mandiri dengan HTML/CSS/JavaScript inline yang bisa dibuka langsung. Jika file pendukung diperlukan, taruh hanya di subfolder prototype yang sama. Jangan memakai framework, bundler, server, install, atau dependency yang tidak dibutuhkan.

Tulis untuk orang yang akan meninjau behavior, bukan hanya developer:

1. Judul dan penjelasan satu kalimat tentang pertanyaan yang diuji.
2. Current state dalam panel yang terbaca dan memakai istilah domain; hindari raw JSON sebagai tampilan utama.
3. Setiap action tersedia sebagai tombol free-play untuk mencoba urutan sendiri.
4. Guided walkthrough berupa tab scenario. Pilih happy path dan kasus sulit/ilegal yang relevan; setiap langkah adalah tombol dan memulai ulang scenario mereset ke initial state yang diketahui.
5. Setelah setiap action, render ulang seluruh state relevan dan jelaskan perubahan penting.

Gunakan styling restrained dan tanpa animasi/gimmick yang mengganggu. State tetap in-memory. Jika action tidak legal, tampilkan hasil sesuai model yang sedang diuji; jangan diam-diam membetulkan model.

### 4. Review dan evaluasi

Berikan path `.workspace/prototypes/<slug>/index.html` atau buka file untuk user, lalu minta user mencoba free-play dan walkthrough. Catat feedback langsung—misalnya behavior yang terasa salah atau dugaan yang ternyata berbeda—sebagai evidence utama. Bandingkan singkat dengan success criteria dan invariant dari brief.

Gunakan status `validated`, `inconclusive`, atau `rejected` sesuai hasil yang teramati. Jangan menganggap tidak ada feedback sebagai validasi; gunakan `inconclusive` bila kriteria belum terjawab.

### 5. Capture dan cleanup

Decision capture mengikuti `Capture Format` dan mode di `../SKILL.md`. Catat invariant, transition, atau data/behavior requirement yang tervalidasi untuk implementasi berikutnya. Jangan otomatis membawa shell HTML ke production.

Setelah decision capture selesai, hapus hanya subfolder `.workspace/prototypes/<slug>/` yang dibuat untuk eksperimen ini. Tampilkan path sebelum cleanup; jangan menghapus parent `.workspace/prototypes/`, module existing, atau prototype lain. Jika target berisi file existing atau batas kepemilikan tidak jelas, berhenti dan minta konfirmasi.

## Bentuk Decision Capture

Capture minimal memuat:

- question, hypothesis, dan success criteria;
- path artifact, invariant/state/transition yang diuji;
- skenario dan hasil yang diamati;
- feedback user dan evidence;
- keputusan/status, behavior yang boleh dibawa ke implementasi, serta open risks.

## Anti-Patterns

- Coding sebelum brief disetujui atau meminta izin runnable kedua setelah disetujui.
- Menulis demo di luar `.workspace/prototypes/<slug>/`.
- Mengubah source/module aplikasi agar prototype berjalan.
- Membuat TUI atau memerlukan developer environment untuk demo yang bisa berupa satu HTML.
- Menggabungkan logic dengan DOM, `document`, atau button handler.
- Menampilkan hanya raw JSON sehingga user tidak memahami state.
- Membuat logic prototype bergantung pada database, persistence, atau network nyata.
- Menambah test, abstraksi, atau fitur yang tidak menjawab pertanyaan.
- Menganggap hasil inconclusive sebagai keputusan final.
- Menghapus logic/code existing atau prototype lain saat cleanup.
