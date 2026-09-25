# UI Prototype

Branch `UI` menjawab satu pertanyaan tampilan dengan **varian runnable mandiri** yang bisa dibandingkan langsung. Artifact UI selalu dibuat di `.workspace/prototypes/<slug>/`; jangan mengubah source atau route aplikasi. Hasil utamanya adalah pengalaman mencoba opsi dan feedback user; decision capture merangkum pilihan serta alasannya.

## Kapan Dipakai

- “Layout mana yang membuat action utama lebih mudah ditemukan?”
- “Dashboard ini lebih baik memakai sidebar atau command surface?”
- “Bagaimana hierarchy informasi pada settings screen?”
- “Saya ingin mencoba beberapa struktur UI sebelum memilih.”

## Alur UI

### 1. Brief dan approval

Ikuti brief dan approval gate di `../SKILL.md`. Tanyakan satu design question dengan success criteria yang bisa diamati. Setelah brief disetujui, persetujuan itu sudah mengizinkan pembuatan varian runnable; jangan meminta approval runnable tambahan.

### 2. Siapkan prototype mandiri

1. Tentukan work root mengikuti aturan di `../SKILL.md`, lalu buat subfolder unik `.workspace/prototypes/<slug>/`.
2. Baca screen/route, data shape, design system, typography, dan responsive behavior yang relevan **sebagai referensi saja**.
3. Buat `index.html` mandiri dengan HTML/CSS/JavaScript inline. Gunakan mock/sample data yang realistis; jangan memakai auth, fetch, atau mutation aplikasi.
4. Jika butuh asset tambahan, simpan di subfolder prototype yang sama. Jangan import source/component dari luar subfolder dan jangan mengubah route/source aplikasi.
5. Jika rancangan tidak bisa diuji secara bermakna tanpa wiring ke aplikasi, jelaskan batasannya lalu minta approval untuk mengubah scope; jangan mengintegrasikan diam-diam.

### 3. Buat varian struktural

- Default **3 varian**, maksimal 3 dalam satu pertanyaan.
- Setiap varian harus berbeda pada layout, information hierarchy, atau primary affordance. Perbedaan warna/copy saja bukan varian desain.
- Tampilkan data dan konten yang sebanding di tiap varian agar feedback fokus pada desain.
- Gunakan gaya visual project sebagai referensi, tetapi prototype harus tetap dapat berjalan sendiri.

### 4. Tambahkan switcher sementara

Buat switcher yang terlihat jelas bukan bagian dari desain yang dievaluasi:

- tombol kiri/kanan untuk berpindah varian dan wrap-around;
- label varian, misalnya `B (Sidebar layout)`;
- keyboard navigation (`←`/`→`); jangan ambil alih tombol panah saat input, textarea, atau `[contenteditable]` sedang fokus;
- bila prototype dijalankan melalui local server, dukung `?variant=<key>` agar pilihan bisa dibuka langsung. Switcher tetap harus bekerja tanpa mengubah aplikasi host.

### 5. Jalankan dan minta feedback

Berikan path `.workspace/prototypes/<slug>/index.html` dan instruksi menjalankan (default: buka file langsung; jika perlu server, berikan satu command). Tanyakan varian yang dipilih, apa yang mudah/sulit ditemukan, komponen apa yang ingin digabung, serta kekurangan yang terlihat. Jangan menganggap preferensi yang belum ditinjau sebagai feedback.

### 6. Evaluasi desain

Feedback langsung user adalah bukti utama; gunakan criteria singkat dari brief untuk membantu membandingkannya. Jangan memberi skor numerik kecuali memang diminta. Tinjau aspek yang relevan:

- hierarchy dan discoverability;
- tujuan tiap varian dan kecocokan dengan data;
- keyboard/focus dan accessibility;
- responsive behavior dan density;
- risiko implementasi atau constraint design system.

Catat varian yang dipilih (atau kombinasi antarvarian), alasan/feedback, evidence yang teramati, serta criteria yang belum terjawab. Gunakan status `validated`, `inconclusive`, atau `rejected` sesuai evidence—bukan selera visual asisten.

### 7. Capture dan cleanup

Decision capture mengikuti `Capture Format` dan mode di `../SKILL.md`. Catat design requirements yang dapat dibawa ke implementasi; jangan mempromosikan komponen prototype langsung ke production.

Setelah decision capture selesai, bersihkan hanya subfolder `.workspace/prototypes/<slug>/` yang dibuat untuk eksperimen ini. Tampilkan path sebelum cleanup; jangan menghapus parent `.workspace/prototypes/` atau prototype lain. Jika target berisi file existing atau batas kepemilikan tidak jelas, berhenti dan minta konfirmasi.

## Bentuk Decision Capture

Capture minimal memuat:

- question, hypothesis, host context, dan success criteria;
- path prototype dan varian struktural yang dicoba;
- feedback pilihan user, termasuk kombinasi elemen jika ada;
- evidence dan trade-off yang relevan;
- keputusan/status, requirements untuk implementasi, serta open risks.

## Anti-Patterns

- Coding sebelum brief disetujui atau meminta izin runnable kedua setelah disetujui.
- Menulis artifact UI prototype di luar `.workspace/prototypes/<slug>/`.
- Mengubah source/route aplikasi untuk menjalankan prototype.
- Membuat satu mockup statis ketika pertanyaannya perlu membandingkan beberapa opsi.
- Varian yang hanya berbeda warna atau spacing.
- Menghubungkan prototype ke auth, fetch, mutation, atau backend nyata.
- Membiarkan prototype switcher atau varian eksperimen masuk production.
- Mengklaim layout tervalidasi tanpa feedback/evidence yang mendukung.
- Menghapus source aplikasi atau prototype lain saat cleanup.
