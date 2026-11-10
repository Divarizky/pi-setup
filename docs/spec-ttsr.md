# Requirements: modul TTSR di extensions/code-safety

## Tujuan
Menegakkan aturan perilaku model saat runtime, bukan hanya lewat system prompt. Aturan ditegakkan di empat titik: stream respons, argumen tool sebelum eksekusi, hasil tool, dan penutupan giliran.

## Lingkup
Modul baru `extensions/code-safety/modules/ttsr/`, didaftarkan dari `extensions/code-safety/index.ts` dengan try/catch sendiri. Tidak ada dependensi baru. Tidak mengubah modul code-safety lain, kecuali pendaftaran di `index.ts`.

## Di luar lingkup
Syntax check otomatis pasca-edit, scope guard dari write_scope orchest, AST matching, judge LLM.

## Requirement fungsional
- FR-1 Rule berupa berkas markdown berfrontmatter di `modules/ttsr/rules/*.md`. Field: `name` (wajib, unik), `description`, `action` (`strip|abort|block|log`, wajib), `scope` (`text|thinking|tool:<nama>`, wajib), `condition` (daftar regex, wajib), `flags` (default `i`), `anchor` (`start|any`, default `any`), `unlessUserSays` (daftar regex, opsional), `maxPerTurn` (default 1), `enabled` (default true). Isi markdown di bawah frontmatter adalah teks koreksi.
- FR-2 Rule tidak valid dilewati dengan peringatan yang menyebut nama berkas dan alasan. Satu rule rusak tidak menghentikan rule lain.
- FR-3 Matcher bekerja inkremental pada delta stream, dengan buffer jendela (default 2000 karakter terakhir) agar pola yang terpotong antar delta tetap terdeteksi. Satu rule memicu paling banyak `maxPerTurn` kali per giliran.
- FR-4 Aksi `strip`: pelanggaran dihapus dari teks final lewat `message_end`, tanpa abort dan tanpa retry.
- FR-5 Aksi `abort`: `ctx.abort()` dari `message_update`. Pesan parsial dikosongkan di `message_end`, disaring dari konteks berikutnya lewat event `context`, lalu koreksi dikirim saat `agent_settled` lewat `pi.sendMessage(..., { triggerTurn: true })` berisi blok `<system-interrupt reason="rule_violation" rule="NAMA">TEKS KOREKSI</system-interrupt>`.
- FR-6 Batas retry koreksi: 2 per pesan user. Counter direset pada `before_agent_start` bila pesan berasal dari user.
- FR-7 Aksi `block`: untuk scope `tool:*`, hook `tool_call` mengembalikan blokir dengan alasan berisi teks koreksi. Cocokkan regex pada JSON argumen tool yang di-stringify. Bila `unlessUserSays` cocok dengan pesan user terakhir, blokir dilewati.
- FR-8 Aksi `log`: hanya mencatat pelanggaran. Tidak mengubah perilaku apa pun.
- FR-9 Settle-gate: bila ada mutasi (tool `edit`, `write`, `hash_edit`, `conflict_resolver`) dan belum ada verifikasi (bash yang cocok dengan pola validasi: test, check, build, tsc, lint, git diff), `agent_before_settle` menolak penutupan satu kali per run dengan pesan yang meminta verifikasi. Harus akur dengan handler `agent_before_settle` lain (failure-recovery, todos).
- FR-10 Setiap pelanggaran ditulis sebagai satu baris JSON ke `<agent-dir>/ttsr-log.jsonl`: `ts`, `rule`, `action`, `scope`, `excerpt` (maksimal 120 karakter). Rule bernama `secret-in-write` tidak boleh menulis excerpt sama sekali.
- FR-11 Perintah `/ttsr`: `list` (nama, action, status), `on <rule>`, `off <rule>`, `stats` (jumlah pelanggaran per rule dari log). Status on/off disimpan di `<agent-dir>/ttsr-state.json` dan bertahan antar sesi.
- FR-12 Rule bawaan (default turunan dari AGENTS.md):
  - Stream, mulai dari `action: log`: `empty-validation` (frasa pembuka validasi kosong), `ai-vocabulary` (kosakata AI terlarang), `generic-closing` (penutup basa-basi).
  - Tool: `git-commit-push` (`block`, `unlessUserSays: commit|push`), `secret-in-write` (`block`, pada isi write/edit), `tautology-test` (`log`, pada berkas `*.test.*`).

## Requirement non-fungsional
- NFR-1 Inti (parser, matcher, strip) berupa fungsi murni tanpa akses Pi API, supaya bisa diuji tanpa runtime.
- NFR-2 Kegagalan modul tidak boleh menjatuhkan sesi. Semua handler dibungkus penangkap error yang hanya mencatat peringatan.
- NFR-3 Overhead per delta stream harus kecil: tanpa alokasi besar, regex dikompilasi sekali saat load.
- NFR-4 Tes menguji kontrak yang teramati (apa yang dipotong, diblokir, dicatat). Dilarang tes source-grep, tautologi, dan echo statis.

## Kriteria keberhasilan
- `npm run check` root bersih. `npm run test:code-safety` lulus, termasuk tes baru.
- Probe e2e di sesi Pi nyata: satu rule `abort` memotong output, partial hilang dari konteks, koreksi terkirim, retry berhenti di batas.

## Hal yang belum terbukti (wajib dilaporkan apa adanya)
- Apakah retry setelah abort memakai cache prefix provider.
- Apakah teks yang sudah tampil di TUI ikut hilang saat `message_end` mengganti pesan.
Bila tidak bisa diuji, tulis "belum terverifikasi" di REPORT.md. Jangan menyimpulkan.

## Sumber acuan
- Pi: `/home/user/.pi/agent/install/releases/1.5.1/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (bagian message_update, message_end, context, tool_call, agent_before_settle, agent_settled).
- Vault: `~/GDrive/AGENT-MEMORY/pi-memory/projects/my-pi-setup/decisions/kelayakan-dan-blueprint-desain-pola-ttsr-pi-coding-agent.md`.
- Pola kode yang ada: `extensions/code-safety/modules/failure-recovery/register.ts`.
