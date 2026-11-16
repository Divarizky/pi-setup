# Extensions: Todos & Task Execution Coordinator

Extension `todos` mengelola pelacakan tugas deklaratif (*declarative task tracking*), deteksi inaktivitas (*inactivity nudge*), koordinasi penyelesaian giliran (*settle coordinator*), dan gerbang validasi integritas kode (*task-aware validation gate*) untuk agen Pi.

---

## 1. Konfigurasi Kebijakan (`reminder` & `nudge`)

Konfigurasi disimpan dan dibaca secara hot-reload dari `~/.config/todos/config.json`. Seluruh nilai bersifat opsional dan memiliki fallback default yang aman.

```json
{
  "taskGateMode": "warn",
  "judgeMode": "enforce",
  "reminder": {
    "enabled": true,
    "maxContinuations": 1,
    "maxInterventions": 2,
    "dedupFingerprint": true
  },
  "nudge": {
    "enabled": true,
    "threshold": 12,
    "maxPerRequest": 2
  }
}
```

### Opsi Konfigurasi `reminder`
- **`enabled`** (`boolean`, default: `true`): Mengaktifkan atau menonaktifkan completion reminder pada `agent_before_settle`.
- **`maxContinuations`** (`number`, default: `1`): Batas maksimal berapa kali completion reminder dapat memicu `continue: true` dalam satu siklus prompt pengguna.
- **`maxInterventions`** (`number`, default: `2`): Anggaran intervensi gabungan (*unified intervention budget*) yang dibagi bersama antara penegakan `task-judge` (unverified code edits) dan `todos-reminder`. Mencegah terjadinya cascade continuation berulang tanpa akhir.
- **`dedupFingerprint`** (`boolean`, default: `true`): Mengaktifkan deduplikasi berbasis fingerprint hash status task. Jika kondisi task tidak berubah sejak intervensi sebelumnya pada prompt yang sama, reminder tidak akan memicu continuation lagi.

### Opsi Konfigurasi `nudge`
- **`enabled`** (`boolean`, default: `true`): Mengaktifkan atau menonaktifkan deteksi inaktivitas tugas selama mutasi berkelanjutan.
- **`threshold`** (`number`, default: `12`): Ambang batas mutasi berturut-turut tanpa progres todo sebelum pesan `steer` (`todos-nudge`) dikirimkan.
- **`maxPerRequest`** (`number`, default: `2`): Batas maksimal berapa kali pesan nudge dapat dikirimkan dalam satu permintaan pengguna aktif (dilengkapi deduplikasi fingerprint otomatis).

---

## 2. Kebijakan & Aturan Eksekusi

### 2.1 Deduplikasi & Budget Intervensi Bersama
1. **Scope Permintaan Pengguna**: Budget intervensi dan counter continuation direset setiap kali ada giliran prompt baru dari pengguna (`before_agent_start` dengan `messageType === "user"`). Continuation internal, notifikasi worker, atau low-level agent runs tidak mereset budget.
2. **Fingerprint Deduplication**: Reminder menghitung hash fingerprint dari task actionable. Jika kondisi task pada giliran berikutnya identik dengan fingerprint sebelumnya, reminder tidak akan memaksa continuation ulang.
3. **Unified Intervention Budget**: Penegakan validasi kode (`task-judge`) dan pengingat todo (`todos-reminder`) mengonsumsi kuota yang sama (`interventionCount <= maxInterventions`), sehingga agen tidak terjebak dalam loop saling balas antar dua sistem pengingat.

### 2.2 Pengecualian Task Menunggu (*Waiting Exclusions*)
Task tidak dianggap *actionable* dan dikecualikan dari pemaksaan continuation jika:
- **Menunggu Worker/Subagent**: Memiliki metadata `workerId`, `assignedWorker`, atau `delegatedTo` dengan status non-terminal.
- **Menunggu Workflow**: Memiliki metadata `workflowId` atau `status === "waiting"` yang merujuk pada eksekusi terdistribusi/eksternal.
- **Menunggu Input Pengguna**: Asisten menyertakan sinyal penantian terstruktur (misal pertanyaan klarifikasi di akhir pesan, atau flag `structuredWaiting`).
- **Dependensi Belum Selesai**: Task memiliki `blockedBy` yang merujuk pada task ID lain yang masih `pending` atau `in_progress`.

### 2.3 Task Relevan & Isolasi Permintaan Aktif
- Sesi baru atau prompt baru mengadopsi task yang disentuh atau disebutkan (`#id`) dalam prompt aktif. Jika prompt meminta tugas baru yang tidak mengadopsi task lama, task lama dari sesi sebelumnya tidak akan menginterupsi penyelesaian permintaan baru.
- Kata kunci kelanjutan (seperti `lanjut`, `continue`, `todos`, dll.) secara otomatis mengadopsi task yang belum selesai dari sesi sebelumnya.

### 2.4 Inactivity Nudge & Deduplikasi Fingerprint
- **Akumulasi & Pengecualian Mutasi**: Dihitung dari tool mutasi (`edit`, `write`, `bash`, `execute`). Perintah shell baca-saja (*read-only* seperti `git status`, `git diff`, `git log`, `ls`, `grep`, `cat`, `find`, `pwd`) dan perintah validasi tes/linter **tidak** dihitung sebagai mutasi kode.
- **Reset Progres Nyata**: Counter mutasi (`mutationCount`) direset ke 0 saat pengiriman nudge berhasil, atau ketika terjadi perubahan todo nyata (`create`, `delete`, `clear`, atau `update` dengan `changed: true`). Operasi baca-saja (`list`, `get`) dan update tanpa perubahan (`changed: false`) tidak mereset counter.
- **Deduplikasi Fingerprint**: Nudge membaca fingerprint kondisi task aktif (`currentFingerprint`) dan membandingkannya dengan fingerprint nudge sebelumnya (`lastFingerprint`). Jika kondisi task identik (`currentFingerprint === lastFingerprint`), pesan nudge ditekan (*deduplicated*) agar tidak terjadi pengiriman berulang pada status pekerjaan yang sama.
- **Pembaruan Fingerprint & Batas Per Request**: Jika kondisi task berubah (status, subjek, form aktif, atau dependensi), perubahan fingerprint memungkinkan pengiriman nudge berikutnya setelah mencapai threshold, hingga batas maksimal per request (`maxPerRequest: 2`).
- **Siklus Request Baru**: Counter nudge (`nudgesInRequest`) dan riwayat fingerprint (`lastNudgeFingerprint`) hanya direset ketika prompt baru dari pengguna masuk (`before_agent_start` dengan `messageType === "user"`). Continuation turn tidak mereset kuota ini.

### 2.5 Task-Aware Validation Gate
- Pada mode `taskGateMode: "warn"` atau `"strict"`, jika kode diedit tanpa pengujian validasi, task yang memerlukan modifikasi kode akan dicegah untuk diselesaikan (`completed`).
- Namun, task investigasi, riset, atau dokumentasi (misal yang menghasilkan artefak markdown atau review temuan) dikecualikan dari pemblokiran validasi kode unrelated (`isTaskValidationRequired`).

### 2.6 Integrasi Subagents & Workflows
- Menggunakan identitas worker/workflow eksplisit dari payload event `subagents:started`, `subagents:completed`, `subagents:failed`, dan notifikasi workflow.
- Saat delegasi worker atau workflow selesai, status task diperbarui menjadi `reviewReady: true` untuk ditinjau oleh parent agent, tanpa mengklaim todo selesai secara otomatis sebelum verifikasi parent.

---

## 3. Kompatibilitas & Replay Sesi
- Seluruh struktur state todo dijamin kompatibel ke belakang. Sesi lama yang direkonstruksi melalui `session_start`, `session_compact`, atau `session_tree` (`replayFromBranch`) tetap berfungsi penuh.
- Isolasi multi-session terjaga secara ketat; state per-session ID terpisah di store memori dan dibersihkan saat `session_shutdown`.
