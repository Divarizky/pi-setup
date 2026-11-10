# Dokumen Perancangan Teknis: Penggabungan (Merger) Extension `task-judge` dan `todos`

**Status:** Proposed / Ready for Review  
**Versi:** 1.0.0  
**Tanggal:** 10-11-2026  
**Penulis:** Tim Engineering Pi-Setup  
**Komponen Terkait:**  
- `extensions/todos/`  
- `extensions/task-judge/`  
- Runtime Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`)

---

## 1. Ringkasan Eksekutif & Latar Belakang

### 1.1 Konteks Sistem
Di dalam lingkungan pengembangan agen Pi (`pi-setup`), saat ini terdapat dua extension terpisah yang mengawal siklus hidup pekerjaan agen:
1. **`extensions/todos`**: Berfungsi sebagai pelacak status tugas deklaratif tingkat tinggi (*declarative task tracker*). Menyediakan tool `todo`, slash command `/todos`, persistent TUI overlay widget, deteksi inaktivitas (*nudge* setelah 12 mutasi tanpa update), serta pencegah terminasi dini bila ada task yang masih `pending` atau `in_progress` melalui interceptor `agent_before_settle`.
2. **`extensions/task-judge`**: Berfungsi sebagai penguji integritas eksekusi teknis (*operational integrity judge*). Memantau tool edit/write dan eksekusi perintah shell (bash/execute), mengevaluasi apakah perubahan kode telah diverifikasi oleh test runner/linter/build sebelum agen menyelesaikan sesi (*settling*), serta memblokir penyelesaian sesi pada mode `enforce` (dengan batas retry maksimal 2 kali) atau mencatat evaluasi model lapis 2 (*nested judge*).

### 1.2 Permasalahan Arsitektur Saat Ini
Meskipun keduanya bekerja di domain yang sama (yaitu menjamin akuntabilitas dan keberhasilan tugas agen), pemisahan fisik kedua extension menimbulkan sejumlah friksi teknis:
- **Konflik dan Ambiguitas di `agent_before_settle`**: Kedua extension mendaftarkan listener independen pada event `agent_before_settle`. Ketika agen mencoba menyelesaikan giliran/sesi, kedua extension dapat mengembalikan `{ continue: true, entries: [...] }` secara simultan. Hal ini memicu balapan penanganan (*race condition*) atau menimpa pesan arahan agen, sehingga agen menerima instruksi yang tumpang tindih.
- **Ketiadaan *Task-Aware Verification***: `task-judge` saat ini hanya melihat level *run global* (apakah ada edit kode sejak run dimulai). `task-judge` tidak mengetahui task spesifik apa di `todos` yang sedang dikerjakan. Akibatnya, agen dapat menandai sebuah task `todo` sebagai `completed` meskipun file kode terkait baru saja diedit dan belum diuji sama sekali.
- **Asimetri Isolasi Multi-Session**: `todos` memiliki isolasi per-session ID (`sid(ctx)`) dengan manajemen eviction yang ketat pada `session_shutdown`. Sebaliknya, `task-judge` saat ini mengandalkan variabel modul tunggal (`let state: TaskJudgeState = createInitialState()`), yang rentan terhadap interferensi lintas session/subagent.
- **Duplikasi Listener Lifecycle**: Kedua extension mendengarkan `agent_start`, `before_agent_start`, `tool_result`, dan `agent_before_settle` secara terpisah, menambah overhead traversal event di runtime Pi.
- **Fragmentasi Konfigurasi**: Pengguna harus mengelola dua file JSON terpisah (`~/.config/todos/config.json` dan `~/.config/task-judge/config.json`).

### 1.3 Tujuan Penggabungan
Menyatukan `task-judge` dan `todos` ke dalam satu extension kohesif (`todos` atau sistem terpadu) untuk menciptakan pipeline manajemen dan verifikasi tugas agen yang atomik, deterministik, terisolasi per sesi, dan memiliki performa optimal tanpa merusak *backward compatibility*.

---

## 2. Analisis Kode Sumber Saat Ini (Current State Analysis)

### 2.1 Anatomi `extensions/todos`
```
extensions/todos/
├── index.ts                 # Lifecycle listeners & runtime coordination
├── types.ts                 # Domain types & TypeBox schema TodoParamsSchema
├── config.ts                # Hot-reload JSON config (~/.config/todos/config.json)
├── tool.ts                  # Pendaftaran tool "todo" & response envelope
├── command.ts               # Slash command /todos
├── locale.ts                # Pendaftaran /lang & kamus i18n (id/en)
├── loader.ts                # Prewarm & dynamic lazy loader untuk TUI widget
├── state/
│   ├── store.ts             # Per-session Map store, branch history rehydration
│   ├── reducer.ts           # Pure state transition, cycle detection, op formatting
│   ├── selectors.ts         # Query helpers (getActiveTodos, findTask, dll.)
│   ├── reminder.ts          # Heuristik deteksi pertanyaan user & pending reminder
│   └── nudge.ts             # Counter mutasi & pemicu pesan steer (threshold: 12)
└── overlay/
    ├── widget.ts            # TodosOverlay (turunan Component dari @earendil-works/pi-tui)
    └── format.ts            # Terminal formatting, badge status, box drawing
```

**Mekanisme Utama `todos`:**
- **Replay dari Branch History**: Pada `session_start`, `session_compact`, dan `session_tree`, state direkonstruksi dari history branch pesan LLM dengan memfilter `toolResult.toolName === "todo"`.
- **Inactivity Nudge**: Pada `tool_result`, jika terjadi 12 mutasi berurutan (`edit`, `write`, atau perintah eksekusi yang mengubah sistem) tanpa interaksi atau update todo, dikirimkan pesan berkategori `steer` (`todos-nudge`) tanpa memicu turn baru.
- **Pending Task Gate**: Pada `agent_before_settle`, jika masih ada task `pending` atau `in_progress`, dan teks terakhir asisten tidak mengandung pola menunggu user (`isWaitingForUserInput`), sesi dicegah selesai dengan menyuntikkan `todos-reminder` dan `continue: true` (maksimal 3 kali).

### 2.2 Anatomi `extensions/task-judge`
```
extensions/task-judge/
├── index.ts                 # Lifecycle listeners & settle gatekeeper
├── judge.ts                 # Evaluator run, command segmenter, validation matcher
├── nested-judge.ts          # Evaluator model Lapis 2 via ctx.modelRegistry (fail-open)
├── config.ts                # Config loader (~/.config/task-judge/config.json)
├── project-validation.ts    # Auto-detection skrip proyek (package.json, Makefile, justfile, pyproject.toml)
├── logger.ts                # Append-only durable judge logs
└── templates.json           # Template checklist prewalk untuk mode enforce
```

**Mekanisme Utama `task-judge`:**
- **Pelacakan Edit & Validasi**: Menangkap `tool_result`. Jika `edit`/`write`, dicatat jika path berada di dalam `cwd` dan bukan file dokumentasi atau scratch. Jika `bash`/`execute`, perintah dipecah (*command segmentation*), diperiksa apakah terdapat pipeline dengan exit code tersembunyi (*masked exit code*), dan dicocokkan dengan pola regex validasi.
- **Settle Enforcement**: Pada `agent_before_settle`, jika ada kode yang diedit setelah perintah validasi sukses terakhir:
  - Mode `off`: Tidak melakukan tindakan.
  - Mode `warn`: Menampilkan notifikasi UI `ctx.ui.notify(..., "warning")`.
  - Mode `enforce`: Mengembalikan `{ continue: true, entries: [...] }` berisi peringatan prewalk checklist (maksimal 2 kali per user prompt).
- **Nested Judge (Lapis 2)**: Jika mode bukan `off` dan evaluasi lapis 1 menyatakan `tidak_terverifikasi`, model eksternal (misal `zenith-router:ag/gemini-3.8-flash`) dipanggil secara asynchronous untuk memverifikasi teks asisten terakhir. Hasil dicatat di log tanpa memblokir keputusan lapis 1.

### 2.3 Matriks Perbandingan Interaksi Event

| Event Pi Lifecycle | Perilaku Saat Ini di `todos` | Perilaku Saat Ini di `task-judge` | Potensi Konflik Saat Terpisah |
| :--- | :--- | :--- | :--- |
| `session_start` | `replaceState(id, replayFromBranch(ctx))` & attach UI overlay. | *(Tidak mendengarkan)* | State `task-judge` tidak terikat session. |
| `agent_start` | Sembunyikan completed task turn sebelumnya di overlay. | Reset `state = createInitialState()`. | State judge di-reset pada setiap turn LLM, bukan per sesi. |
| `before_agent_start` | Reset counter reminder jika `messageType === "user"`. | Reset counter enforce retry jika `messageType === "user"`. | Duplikasi pemantauan awal turn. |
| `tool_result` | Hitung consecutive mutation untuk inactivity nudge (12x). | Deteksi edit path & segmentasi perintah validasi. | Dua kali parsing tool result secara independen. |
| `tool_execution_end` | Refresh UI overlay setelah tool `todo` sukses. | *(Tidak mendengarkan)* | Tidak ada gate verifikasi saat update status task. |
| `agent_before_settle` | Intercept jika ada task `pending`/`in_progress` (max 3x). | Intercept jika ada unverified edits di mode `enforce` (max 2x). | **KRITIS:** Kedua extension mengembalikan `continue: true` dan mengganti/menambah entries secara balapan. |
| `session_shutdown` | Evict session slot & dispose overlay widget. | *(Tidak mendengarkan)* | Kebocoran memory tracking di task-judge. |

---

## 3. Analisis Kelayakan & Trade-offs (Feasibility Analysis)

### 3.1 Kesimpulan Kelayakan: **SANGAT LAYAK (HIGH FEASIBILITY)**
Penggabungan kedua extension sangat direkomendasikan karena domain fungsional keduanya bersinggungan langsung: `todos` adalah *intent & plan layer*, sedangkan `task-judge` adalah *execution & verification gate*. Menyatukan keduanya menghilangkan celah integrasi yang ada.

### 3.2 Analisis Keuntungan (Pros)
1. **Koordinasi Tunggal `agent_before_settle` (Unified Settle Pipeline)**:
   Keputusan apakah agen diizinkan berhenti (*settle*) dievaluasi dalam satu titik koordinasi terpadu dengan prioritas deterministik:
   - Prioritas 1: **Enforce Code Integrity** (Jika ada edit kode yang belum diuji, wajib diselesaikan/ditest lebih dulu).
   - Prioritas 2: **Pending Task Tracker** (Jika kode sudah lolos uji, pastikan status task todo diperbarui).
   Pesan peringatan yang dikembalikan ke LLM menjadi satu paket pesan komprehensif, bukan dua pesan yang membingungkan.
2. **Task-Level Verification Gate**:
   Dengan penggabungan, validasi tidak lagi hanya beroperasi di tingkat sesi global. Ketika agen memanggil `todo(action="update", id=X, status="completed")`, extension dapat langsung memeriksa: *"Apakah terdapat edit file sejak task ini dimulai yang belum divalidasi dengan test runner?"*. Jika ada, operasi update status dapat diperingatkan atau ditolak sesuai konfigurasi.
3. **Eliminasi Masalah Multi-Session di `task-judge`**:
   State pelacakan edit dan validasi dimasukkan langsung ke dalam per-session slot di `store.ts`. Dengan demikian, eksekusi subagent atau multi-session tidak akan saling menimpa state verifikasi.
4. **Efisiensi Runtime Event & I/O**:
   Hanya satu event listener untuk `tool_result`, `agent_before_settle`, dan `before_agent_start`.
   Inactivity nudge dan validation detection dapat saling bertukar sinyal (misalnya: jika mutasi ke-10 adalah perintah test yang sukses, counter mutasi dapat disesuaikan).
5. **Penyederhanaan Konfigurasi Pengguna**:
   Satu direktori konfigurasi `~/.config/todos/config.json` yang menaungi pengaturan widget UI sekaligus aturan judge dan prewalk template.

### 3.3 Analisis Risiko & Strategi Mitigasi (Risks & Mitigations)

| Risiko | Tingkat | Dampak | Strategi Mitigasi |
| :--- | :--- | :--- | :--- |
| **Separation of Concerns & Code Bloating** | Sedang | File menjadi terlalu besar, mencampur TUI rendering dengan regex validation. | Pisahkan struktur folder menjadi submodul tegas: `core/`, `judge/`, `lifecycle/`, dan `overlay/`. File `index.ts` hanya bertindak sebagai orkestrator tipis (*wiring layer*). |
| **Beban Startup & UI Overhead** | Rendah | Mengimpor modul TUI memberatkan mode headless / subagent. | Pertahankan pola dynamic import (`loader.ts`) untuk `overlay/widget.ts`. Komponen analitik `judge` tidak memiliki dependensi ke `@earendil-works/pi-tui`. |
| **Kerusakan Replay History (Backward Compatibility)** | Tinggi | Sesi lama gagal di-replay saat upgrade extension. | Nama tool `"todo"`, struktur snapshot `TaskDetails`, dan signature TypeBox `TodoParamsSchema` dipertahankan tanpa perubahan yang merusak. Field baru hanya bersifat opsional di `metadata`. |
| **Migrasi Konfigurasi Lama** | Rendah | Konfigurasi `task-judge/config.json` pengguna diabaikan. | Implementasikan konfigurasi loader dengan *fallback cascade*: membaca `~/.config/todos/config.json`, jika parameter judge kosong, baca dari `~/.config/task-judge/config.json`. |

---

## 4. Desain Arsitektur Teknis Sistem Terpadu (Target Architecture)

### 4.1 Penamaan & Lokasi Extension
- **Keputusan**: Tetap mempertahankan direktori dan nama extension **`extensions/todos`**.
- **Dasar Pertimbangan**:
  - Di Pi Coding Agent, nama tool `"todo"` dan slash command `"/todos"` terikat erat pada history branch replay.
  - Konfigurasi runtime Pi di `~/.pi/agent` dan script audit/test di `package.json` telah mengacu pada `todos`.
  - Direktori `extensions/task-judge/` akan dipensiunkan (deprecated) setelah fungsionalitasnya selesai dimigrasikan ke `extensions/todos/`.

### 4.2 Struktur Direktori Usulan
```
extensions/todos/
├── index.ts                      # Entrypoint utama: pendaftaran tool, command, lifecycle hooks
├── types.ts                      # Tipe domain terpadu (Task, JudgeState, Config, Enums)
├── config.ts                     # Konfigurasi terpadu (hot-reload + fallback task-judge)
├── tool.ts                       # Registrasi tool "todo" + Hook validasi task status
├── command.ts                    # Registrasi slash command (/todos, /judge-mode)
├── locale.ts                     # Pendaftaran /lang dan bundle i18n
├── loader.ts                     # Dynamic lazy-loader untuk komponen TUI
│
├── core/                         # Domain Core & Manajemen State Tugas
│   ├── store.ts                  # Per-session state store (Tasks + SessionJudgeState)
│   ├── reducer.ts                # Reducer transisi status tugas, dependensi cycle check
│   ├── selectors.ts              # Query helper status tugas
│   └── replay.ts                 # Rekonstruksi state dari LLM branch message history
│
├── judge/                        # Engine Analitik Verifikasi Integritas Kode
│   ├── engine.ts                 # Evaluator run & verifikasi rentang order edit vs test
│   ├── command-parser.ts         # Shell command segmentation, wrapper stripper, pipefail detector
│   ├── patterns.ts               # Default regex patterns & non-validating prefixes
│   ├── project-detector.ts       # Deteksi otomatis pola test proyek (package.json, Makefile, dll.)
│   ├── nested-judge.ts           # Evaluasi LLM Lapis 2 via model registry (fail-open)
│   ├── logger.ts                 # Logging terstruktur ke append-only file jsonl
│   └── templates.json            # Prewalk checklist templates untuk mode enforce
│
├── lifecycle/                    # Orkestersi Event & Interceptor Pi
│   ├── settle-coordinator.ts     # Orkestersi terpadu agent_before_settle (Enforce + Reminders)
│   ├── nudge.ts                  # Logika penghitung mutasi & inactivity steer message
│   └── reminder.ts               # Heuristik deteksi pertanyaan user & pending task reminder
│
└── overlay/                      # UI Chrome & Visualisasi Terminal (Lazy-loaded)
    ├── widget.ts                 # TodosOverlay component (@earendil-works/pi-tui)
    └── format.ts                 # ANSI formatters, badges, dan spinners
```

---

### 4.3 Layering Modular & Pemisahan Tanggung Jawab (Separation of Concerns)

Arsitektur dibagi menjadi 4 layer vertikal yang independen:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       1. RUNTIME & INTERFACE LAYER                          │
│     index.ts  │  tool.ts ("todo")  │  command.ts  │  overlay/ (TUI Widget)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                      2. LIFECYCLE & COORDINATION LAYER                      │
│   settle-coordinator.ts  │  nudge.ts  │  reminder.ts  │  command-parser.ts  │
└───────────────────┬─────────────────────────────────────┬───────────────────┘
                    │                                     │
┌───────────────────▼──────────────────┐  ┌───────────────▼───────────────────┐
│     3A. TASK MANAGEMENT CORE         │  │     3B. JUDGE & VERIFY ENGINE     │
│   store.ts (Per-session Store)       │  │   engine.ts (Order evaluation)    │
│   reducer.ts (Task state machine)    │  │   patterns.ts & project-detector  │
│   replay.ts (Branch rehydration)     │  │   nested-judge.ts & logger.ts     │
└──────────────────────────────────────┘  └───────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                          4. CONFIGURATION & TYPES                           │
│           config.ts (Hot-reload, XDG fallback)  │  types.ts                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Interface Layer**: Mendaftarkan extension API ke Pi. Menerima tool call, CLI command, dan merender widget TUI. Widget TUI di-load secara dinamis (*lazy*) sehingga tidak membebani proses jika berjalan di mode non-interaktif atau subagent.
2. **Lifecycle & Coordination Layer**: Menangani event hook Pi (`tool_result`, `agent_before_settle`, `before_agent_start`). Menghubungkan mutasi tool dengan state store dan mengorkestrasi respons penolakan settle secara terkoordinasi.
3. **Core & Verification Layer**:
   - `Task Management Core`: Mengelola struktur pohon tugas, siklus hidup task (`pending` → `in_progress` → `completed`), dependensi `blockedBy`, dan isolasi per-session.
   - `Judge & Verify Engine`: Fungsi murni (*pure functions*) yang menganalisis riwayat edit vs validasi, segmentasi perintah shell, serta pemicu LLM Lapis 2. Bebas dari efek samping UI.
4. **Configuration & Types Layer**: Kontrak data bersama, TypeBox schema, serta loader konfigurasi JSON dengan hot-reload dan fallback backward compatibility.

---

### 4.4 Model Data Terpadu & Per-Session Store

Di dalam `core/store.ts`, setiap sesi Pi memiliki data slot terisolasi yang menampung sekaligus state tugas dan state verifikasi judge:

```typescript
// types.ts

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type JudgeDecision = "terverifikasi" | "tidak_terverifikasi" | "dikecualikan";
export type JudgeMode = "warn" | "off" | "enforce";

export interface FileEditRecord {
  path: string;
  order: number;
  timestamp: number;
  activeTaskId?: number; // Kaitkan dengan task yang sedang in_progress saat file diedit
}

export interface ValidationRecord {
  command: string;
  success: boolean;
  order: number;
  timestamp: number;
}

export interface SessionJudgeState {
  edits: FileEditRecord[];
  validations: ValidationRecord[];
  nextOrder: number;
  enforceRetries: number;
}

export interface SessionState {
  // Task Management
  tasks: Task[];
  nextId: number;
  // Judge & Verification
  judge: SessionJudgeState;
  // Lifecycle tracking
  reminderCount: number;
  nudgeState: {
    mutationCount: number;
    hasActiveTodos: boolean;
  };
}
```

**Keuntungan Model Ini:**
- Ketika subagent atau sesi baru berjalan, pemanggilan `session_start` secara otomatis menginisialisasi `SessionState` baru di dalam `Map<string, SessionState>`.
- Ketika sesi ditutup (`session_shutdown`), seluruh memori tugas, counter retry, dan riwayat edit otomatis dibersihkan (*evicted*), mencegah kebocoran memori.

---

### 4.5 Pola Integrasi Internal

#### A. Task-Aware Verification Hook (Pada Saat Tool `todo` Dipanggil)
Saat agen memanggil `todo` dengan `action: "update"`, `id: X`, dan `status: "completed"`:
1. Sistem memeriksa riwayat edit di `state.judge.edits`.
2. Jika ditemukan edit file kode yang terjadi saat task X sedang aktif atau setelah validasi sukses terakhir:
   - **Mode Enforce / Strict**: Tool `todo` mengembalikan status error deskriptif:
     `"Gagal menyelesaikan task #X: Berkas 'src/core.ts' telah diubah tetapi belum divalidasi dengan test runner yang sukses. Jalankan pengujian sebelum menandai task selesai."`
     State task tetap berada pada `in_progress`.
   - **Mode Warn (Default)**: Task tetap diubah menjadi `completed`, namun pada pesan kembalian disematkan catatan peringatan:
     `"Updated #X (in_progress → completed). Peringatan: Terdapat perubahan kode yang belum divalidasi dengan pengujian."`

#### B. Unified Settle Coordinator (Pada Saat `agent_before_settle`)
Ketika agen hendak mengakhiri gilirannya, `settle-coordinator.ts` mengeksekusi pipeline terpadu:

```
                          [agent_before_settle]
                                    │
                         Outcome === "aborted" /
                         Subagent parentSession?
                                ├── Ya ──> [Izinkan Settle (Exit)]
                                │
                               Tidak
                                    │
                  Evaluasi Integritas Kode (Judge Engine)
                                    │
                    Apakah ada unverified code edits?
                                ├── Ya
                                │   ├── Mode "enforce":
                                │   │   Retry < ENFORCE_MAX_RETRIES (2)?
                                │   │   ├── Ya ──> [TOLAK SETTLE: Suntikkan Prewalk Checklist]
                                │   │   └── Tidak ──> [UI Notify Warning: Batas retry tercapai]
                                │   └── Mode "warn":
                                │       [UI Notify Warning: File diedit tanpa validasi]
                                │
                               Tidak / Lolos Judge
                                    │
                     Evaluasi Status Tugas (Todo Tracker)
                                    │
                    Apakah ada task pending / in_progress?
                                ├── Ya
                                │   Asisten menunggu input user (isWaitingForUserInput)?
                                │   ├── Ya ──> [Izinkan Settle (Menunggu User)]
                                │   └── Tidak ──>
                                │       ReminderCount < MAX_RETRIES (3)?
                                │       ├── Ya ──> [TOLAK SETTLE: Suntikkan Todos Reminder]
                                │       └── Tidak ──> [Izinkan Settle (Budget reminder habis)]
                                │
                               Tidak
                                    │
                           [IZINKAN SETTLE]
```

**Prinsip Desain Settle:**
- Integritas kode (*code correctness*) memiliki preseden lebih tinggi daripada penutupan daftar tugas. Jika kode rusak/belum dites, agen harus memperbaikinya terlebih dahulu sebelum merapikan checklist todo.
- Hanya satu entri pesan pengarah (`custom_message`) yang disuntikkan ke context pesan dalam satu waktu, menghindari kebingungan model LLM.

---

### 4.6 Skema Konfigurasi Terpadu (Unified Configuration)

Konfigurasi disimpan di `~/.config/todos/config.json`. Jika properti terkait judge belum disetel di sana, loader akan melakukan fallback otomatis ke `~/.config/task-judge/config.json`.

```typescript
// config.ts

export interface TodosUnifiedConfig {
  // --- Pengaturan TUI & Display (Eksisting todos) ---
  maxWidgetLines?: number;         // Default: 12 (min: 3)
  collapseKey?: string;            // Default: "ctrl+shift+t", atau "off"
  locale?: "id" | "en";            // Default: "en" (/lang switchable)

  // --- Pengaturan Integritas & Judge (Migrasi task-judge) ---
  judgeMode?: "warn" | "off" | "enforce"; // Default: "warn"
  docExtensions?: string[];        // Default: [".md", ".mdx", ".txt", ".rst"]
  validationPatterns?: string[];   // Pola regex kustom test/build runner
  taskGateMode?: "strict" | "warn" | "off"; // Default: "warn" (gate pada todo update)

  // --- Nested Judge Lapis 2 ---
  nestedJudge?: {
    enabled?: boolean;             // Default: false
    model?: string;                // Default: "zenith-router:ag/gemini-3.8-flash"
    timeoutMs?: number;            // Default: 20000
  };

  // --- Inactivity Nudge & Reminders ---
  nudgeThreshold?: number;         // Default: 12 mutasi berurutan
  maxReminderRetries?: number;     // Default: 3 kali
}
```

---

## 5. Rencana Pengujian (Testing Strategy)

Pengujian harus memastikan tidak ada regresi pada fungsionalitas lama dan integrasi baru terbukti aman.

### 5.1 Unit Tests
1. **`core/reducer.test.ts`**:
   - Mempertahankan seluruh skenario pengujian `todos` eksisting (create, update, status transitions, cycle detection `blockedBy`, tombstone handling).
2. **`judge/engine.test.ts` & `judge/command-parser.test.ts`**:
   - Mempertahankan seluruh skenario pengujian `task-judge/judge.test.ts` (evaluasi run, pengecualian dokumen, segmented shell commands, passive pipes, masked exit codes).
3. **`judge/nested-judge.test.ts`**:
   - Memastikan evaluasi lapis 2 tetap fail-open dan menghormati timeout serta AbortSignal.
4. **`judge/project-detector.test.ts`**:
   - Deteksi otomatis script package.json, Makefile, justfile, dan pyproject.toml.

### 5.2 Integration Tests
1. **`lifecycle/settle-coordinator.test.ts`**:
   - Uji skenario di mana kedua kondisi terjadi bersamaan: ada file diedit tanpa tes DAN ada task pending. Pastikan pesan enforce judge muncul pertama dengan prioritas yang benar.
   - Uji batas maksimal enforce retries (2x) dan reminder retries (3x).
2. **`core/store-multisession.test.ts`**:
   - Uji isolasi state: Edit file pada sesi A tidak boleh memengaruhi evaluasi judge pada sesi B.
   - Uji `session_shutdown`: Memastikan slot sesi bersih total.
3. **`tool/task-gate.test.ts`**:
   - Uji pemanggilan `todo(action: "update", id: 1, status: "completed")` ketika ada unverified edits di mode `strict` vs mode `warn`.

### 5.3 Pembaruan Script `package.json` Root
Script pengujian di root `package.json` disesuaikan:
```json
{
  "scripts": {
    "test:todos": "node --test --experimental-strip-types extensions/todos/**/*.test.ts",
    "test:task-judge": "node -e \"console.log('task-judge telah digabung ke todos; menjalankan test:todos...');\" && npm run test:todos"
  }
}
```

---

## 6. Strategi Migrasi Step-by-Step & Backward Compatibility

Migrasi akan dilaksanakan dalam 5 tahapan terstruktur:

### Tahap 1: Restrukturisasi Direktori Internal `extensions/todos`
1. Pindahkan modul state dan reducers ke subdirektori modular (`core/`, `lifecycle/`, `overlay/`).
2. Pastikan `npm run test:todos` tetap 100% lulus tanpa perubahan fungsional.

### Tahap 2: Porting Modul Engine `task-judge` ke `extensions/todos/judge/`
1. Salin logika analitik murni dari `task-judge/judge.ts`, `nested-judge.ts`, `project-validation.ts`, `logger.ts`, dan `templates.json` ke dalam `extensions/todos/judge/`.
2. Gabungkan skema konfigurasi di `extensions/todos/config.ts` dengan menyertakan fallback loader ke `~/.config/task-judge/config.json`.
3. Jalankan pengujian unit engine judge di dalam pohon `extensions/todos`.

### Tahap 3: Unifikasi Session Store & Lifecycle Hooks
1. Perluas `SessionState` di `extensions/todos/core/store.ts` untuk mencakup riwayat edit dan validasi per sesi.
2. Buat `extensions/todos/lifecycle/settle-coordinator.ts` yang menggabungkan logika penolakan settle dari kedua extension.
3. Sambungkan event listener Pi di `extensions/todos/index.ts` ke coordinator terpadu.

### Tahap 4: Implementasi Task-Aware Gate & Pengujian Integrasi
1. Hubungkan `tool.ts` dengan status verifikasi judge (mode `warn` sebagai default yang aman).
2. Tulis test integrasi untuk skenario kombinasi settle dan task gating.
3. Uji manual pada sesi Pi interaktif dan periksa visualisasi TUI overlay widget.

### Tahap 5: Deprecasi & Penghapusan `extensions/task-judge`
1. Buat shim/stub di `extensions/task-judge/index.ts` yang hanya menampilkan peringatan deprecasi jika extension tersebut masih dimuat secara mandiri, atau hapus entri `task-judge` dari pemuatan global Pi.
2. Sinkronkan ke runtime lokal (`~/.pi/agent/extensions/`).
3. Update dokumentasi arsitektur dan changelog proyek.

---

## 7. Kesimpulan & Rekomendasi Eksekusi

Penggabungan `extensions/task-judge` ke dalam `extensions/todos` adalah langkah evolusi arsitektural yang logis, bersih, dan berdampak tinggi. 

**Rekomendasi Utama:**
1. **Adopsi Arsitektur Layering Modular**: Jaga agar modul UI (`overlay/`) dan modul evaluasi teknis (`judge/`) tetap terpisah secara tegas di tingkat kode sumber agar codebase tetap bersih dan mudah dipelihara.
2. **Prioritaskan Backward Compatibility**: Pertahankan nama tool `"todo"`, skema replay `TaskDetails`, dan sediakan config fallback transparan agar pengguna tidak mengalami hambatan saat pembaruan dirilis.
3. **Aktifkan Task Gating Secara Bertahap**: Mulai dengan `taskGateMode: "warn"` sebagai default, sehingga agen diberi umpan balik edukatif tanpa risiko memutus alur kerja yang sudah berjalan, sebelum beralih ke mode `strict` jika dibutuhkan.
