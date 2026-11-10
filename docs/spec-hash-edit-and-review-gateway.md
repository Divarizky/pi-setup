# Spesifikasi Kebutuhan (Requirements): Hash-Edit, 1 Gerbang Code Review & Taksonomi Triage OMP

## 1. Modul / Tool `hash_edit`

### 1.1 Latar Belakang & Masalah
Tool modifikasi kode bawaan (`edit`) berbasis pencarian string eksak (`oldText` -> `newText`). Pendekatan ini memiliki kelemahan kritis:
1. **Kegagalan Whitespace/CRLF**: Ketidakcocokan spasi indentasi atau variasi newline (`\r\n` vs `\n`) menyebabkan operasi edit gagal (*string not found*).
2. **Anchor Drift pada File Besar**: Saat beberapa baris diedit, pergeseran offset baris sering kali membuat target edit berikutnya meleset.
3. **Pemborosan Token**: Model terpaksa menyertakan blok kode lama yang besar hanya untuk memastikan keunikan anchor.

### 1.2 Tujuan
Menyediakan tool `hash_edit` yang memodifikasi berkas berdasarkan anchor nomor baris dan hash konten per baris (mengadopsi konsep *hashline edits* dari Oh My Pi).

### 1.3 Spesifikasi Fungsional Tool
- **Nama Tool**: `hash_edit`
- **Parameter Input**:
  - `path` (string, wajib): Jalur berkas target relatif terhadap root proyek.
  - `startAnchor` (object, wajib):
    - `line` (number, 1-indexed): Nomor baris awal blok yang akan diganti.
    - `hash` (string, 6 karakter hex): Hash dari baris awal yang dinormalisasi.
  - `endAnchor` (object, wajib):
    - `line` (number, 1-indexed): Nomor baris akhir blok yang akan diganti.
    - `hash` (string, 6 karakter hex): Hash dari baris akhir yang dinormalisasi.
  - `newContent` (string, wajib): Teks baru pengganti blok dari `startAnchor` sampai `endAnchor`.
- **Kalkulasi Hash Baris**:
  1. Hapus karakter `\r` (CR).
  2. Pangkas spasi/tab di akhir baris (`line.trimEnd()`).
  3. Hitung SHA-256 dari baris tersebut dan ambil 6 karakter heksadesimal pertama:
     $$\text{hash} = \text{SHA256}(\text{normalized\_line})[0..6]$$
- **Deteksi Format Newline**:
  - Sebelum menulis ke disk, deteksi format newline dominan pada berkas asli (`\r\n` CRLF atau `\n` LF).
  - Normalisasikan `newContent` ke format newline dokumen asli sebelum penulisan agar riwayat git diff tetap bersih.
- **Strategi Anchor Miss / Pergeseran Baris**:
  1. *Jendela Pemindaian Lokal ($\pm15$ baris)*: Jika baris pada `startAnchor.line` tidak cocok dengan `startAnchor.hash`, pindai dalam radius 15 baris ke atas dan ke bawah.
  2. *Validasi Sinkronisasi Delta*: Jika `startAnchor` dan `endAnchor` ditemukan bergeser dengan selisih offset yang sama ($\Delta_{\text{start}} == \Delta_{\text{end}}$), edit otomatis diterapkan pada rentang yang bergeser tersebut.
  3. *Penolakan Deterministik*: Jika hash tidak ditemukan atau offset tidak konsisten, batalkan edit dan kembalikan cuplikan 5 baris di sekitar baris target beserta nomor baris dan hash terbarunya ke agent.

---

## 2. Prompt Template: "1 Gerbang Code Review"

### 2.1 Konsep Gerbang Tunggal
Mengonsolidasikan `/review` dan `/review-diff` menjadi satu perintah cerdas `/review [target]`:
- **Routing Cerdas**:
  - Jika argumen diberikan (`/review <path|branch|commit>`): Targetkan audit secara eksklusif pada file/direktori atau perbandingan branch tersebut.
  - Jika tanpa argumen & working tree kotor (`git status --porcelain` ada perubahan): Otomatis bertindak sebagai **Uncommitted Diff Review**.
  - Jika tanpa argumen & working tree bersih: Otomatis mendeteksi branch asal (`origin/main` atau commit terakhir `HEAD~1..HEAD`) dan bertindak sebagai **Branch/Commit Review**.
- **Backward Compatibility**: Template `/review-diff` dipertahankan sebagai alias yang meneruskan pemanggilan ke `/review`.

---

## 3. Integrasi Taksonomi Triage OMP (Oh My Pi)

### 3.1 Aturan Reviewer
- **Provable Findings Only**: Larangan keras membuat temuan spekulatif, saran gaya penulisan, atau nitpick kosmetik.
- **Setiap Temuan Wajib Memuat**:
  - `path:line` yang dapat diverifikasi langsung.
  - Jalur bukti reproduksi / jejak eksekusi konkret.
  - Dampak konkret terhadap runtime, data, atau API konsumen.
  - Perbaikan minimal (*smallest valid diff*).
  - Tingkat keyakinan: `[High confidence]` atau `[Medium confidence]` (temuan `Low confidence` dilarang dilaporkan sebagai blocker).

### 3.2 Klasifikasi Tingkat Keparahan (Severity Triage)
- **P0 (Critical Blocker)**: Crash fatal saat runtime, kebocoran kredensial/token/rahasia, *remote code execution*, korupsi/kehilangan data, deadlock.
- **P1 (Bug / Regresi Nyata)**: Pelanggaran kontrak API publik, logic error terbukti, memory leak, unhandled edge-case pada alur utama.
- **P2 (Perf / Defect Sekunder)**: Algoritma $O(N^2)$ di jalur kritis, missing pagination/unindexed query, missing error handling pada I/O sekunder.
- **P3 (Advisory Maintainability)**: Ambiguitas tipe kompleks atau arsitektur yang berisiko regresi jangka panjang.
