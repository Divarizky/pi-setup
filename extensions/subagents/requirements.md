---
version: 1.1.0
created: 10-09-2026
updated: 10-09-2026
source: to-requirements
status: approved
---

# Agent Control Plane

## Problem

Extension sudah dapat menjalankan agent secara paralel dan mengisolasi perubahan memakai Git worktree, tetapi lifecycle `Agent` masih berorientasi pada proses, bukan delivery task. Status task, validation evidence, candidate branch, dan keputusan approval belum dapat dipulihkan secara utuh setelah restart. Selain itu, agent yang selesai belum tentu menghasilkan perubahan yang valid, aman, sesuai scope, atau siap diintegrasikan.

## Solution

Sistem SHALL menambahkan task control plane persisten di atas `AgentManager` untuk top-level `Agent`. Setiap spawn diklasifikasikan sebagai `scout` atau `ship` berdasarkan policy tipe agent dan parameter task. Task `ship` wajib memakai worktree, menjalankan validasi terukur, dan menghasilkan immutable candidate sebelum meminta approval manusia. Task, event lifecycle, validation evidence, candidate, dan approval disimpan secara lokal per repository dan direkonsiliasi saat sesi dimulai kembali.

## User Stories

- **MUST** — Sebagai operator, saya ingin agent `build` bekerja di worktree terpisah agar beberapa implementasi dapat berjalan paralel tanpa menulis ke checkout utama.
- **MUST** — Sebagai operator, saya ingin hasil perubahan disimpan sebagai candidate branch agar pekerjaan agent tidak hilang setelah worktree ditutup atau Pi restart.
- **MUST** — Sebagai operator, saya ingin hanya perubahan yang lolos scope check dan validation command yang dapat diajukan untuk approval.
- **MUST** — Sebagai operator, saya ingin integrasi perubahan membutuhkan konfirmasi eksplisit agar agent tidak dapat merge hanya berdasarkan keputusannya sendiri.
- **MUST** — Sebagai operator, saya ingin task aktif dan candidate tertunda dapat dipulihkan setelah restart.
- **MUST** — Sebagai operator, saya ingin task investigasi benar-benar read-only agar tidak menghasilkan perubahan tanpa sengaja.
- **SHOULD** — Sebagai operator, saya ingin melihat objective, status, changed files, validation evidence, candidate SHA, dan target branch sebelum memberi approval.
- **SHOULD** — Sebagai operator, saya ingin scope overlap terdeteksi sebelum dua task perubahan dijalankan bersamaan.
- **SHOULD** — Sebagai pembuat custom agent, saya ingin mendeklarasikan policy `scout`, `ship`, atau `flexible` lewat metadata agent.
- **NICE** — Sebagai operator, saya ingin melihat riwayat transisi task untuk mendiagnosis crash dan kegagalan delivery.

## Functional Requirements

### FR-1 — Task Classification

1. WHEN top-level `Agent` dipanggil THEN sistem SHALL membuat identitas task stabil sebelum proses agent dimulai.
2. WHEN tipe agent mempunyai policy `scout` THEN sistem SHALL menjalankan task dalam mode read-only tanpa worktree.
3. WHEN tipe agent mempunyai policy `ship` THEN sistem SHALL mewajibkan Git worktree dan menolak downgrade ke mode non-isolated.
4. WHEN tipe agent mempunyai policy `flexible` THEN sistem SHALL mewajibkan pemanggil memilih `scout` atau `ship`.
5. IF custom agent tidak mempunyai task policy saat Agent Control aktif THEN sistem SHALL menolak spawn dengan pesan yang menyebut metadata yang perlu ditambahkan.
6. IF mode task bertentangan dengan policy tipe agent THEN sistem SHALL menolak spawn sebelum agent atau worktree dibuat.

### FR-2 — Scout Isolation

7. WHEN task `scout` dimulai THEN sistem SHALL menyediakan hanya tool baca yang tidak dapat mengubah file.
8. WHILE task `scout` berjalan THEN sistem SHALL mencegah penggunaan file-write tool dan unrestricted shell.
9. WHEN task `scout` selesai THEN sistem SHALL menyimpan laporan dan status terminal tanpa membuat candidate branch.

### FR-3 — Ship Preflight

10. WHEN task `ship` diminta THEN sistem SHALL memverifikasi bahwa working directory berada dalam repository Git yang mempunyai commit dasar.
11. IF checkout utama mempunyai staged, unstaged, atau untracked changes THEN sistem SHALL menolak task `ship` tanpa membuat stash atau WIP commit.
12. WHEN preflight berhasil THEN sistem SHALL merekam repository, target branch, base SHA, write scope, acceptance criteria, dan validation commands.
13. IF write scope task baru bertumpang tindih dengan task `ship` aktif THEN sistem SHALL menolak spawn atau meminta override manusia sebelum pekerjaan dimulai.
14. IF worktree isolation dinonaktifkan pada project THEN sistem SHALL menolak task `ship`, bukan menjalankannya di checkout utama.

### FR-4 — Worktree Safety

15. WHEN task `ship` lolos preflight THEN sistem SHALL membuat worktree dari base SHA yang direkam.
16. IF pembuatan worktree gagal THEN sistem SHALL menandai task gagal dan tidak menjalankan agent di checkout utama.
17. WHEN agent menghasilkan perubahan THEN sistem SHALL menghitung changed files relatif terhadap base SHA.
18. IF perubahan berada di luar write scope THEN sistem SHALL mempertahankan pekerjaan tetapi melarang status `candidate_ready`.
19. IF preservation commit atau pembuatan branch gagal THEN sistem SHALL mempertahankan worktree dan melaporkan `preservation_failed`.
20. WHEN candidate branch berhasil dibuat THEN sistem SHALL memverifikasi bahwa candidate commit dapat di-resolve sebelum menghapus worktree.
21. WHEN tidak ada perubahan dan HEAD worktree tetap sama dengan base SHA THEN sistem SHALL menghapus worktree dan menandai task `completed_no_changes`.

### FR-5 — Validation

22. WHEN agent selesai dengan perubahan THEN sistem SHALL menjalankan validation commands di worktree sebelum cleanup.
23. WHEN validation command selesai THEN sistem SHALL menyimpan command, exit status, timeout state, output terbatas, dan waktu selesai.
24. IF agent mengklaim test berhasil tetapi tidak ada execution evidence THEN sistem SHALL tidak menganggap validation berhasil.
25. IF salah satu validation command gagal atau timeout THEN sistem SHALL mempertahankan perubahan dan menandai task `validation_failed`.
26. WHEN scope check dan seluruh validation command berhasil THEN sistem SHALL membuat immutable candidate yang memuat branch, head SHA, changed files, dan evidence.
27. IF candidate branch bergerak setelah dibuat THEN sistem SHALL membatalkan approval lama dan meminta review ulang.

### FR-6 — Durable State

28. WHEN task dibuat atau berubah status THEN sistem SHALL menyimpan snapshot task secara atomik pada state lokal repository.
29. WHEN lifecycle event terjadi THEN sistem SHALL menambahkan event append-only yang memuat task ID, previous state, next state, reason, dan timestamp.
30. IF proses berhenti ketika snapshot sedang ditulis THEN sistem SHALL mempertahankan snapshot valid terakhir.
31. WHEN sesi baru dimulai THEN sistem SHALL memuat dan merekonsiliasi seluruh task non-terminal milik repository aktif.
32. IF task tersimpan berstatus `preparing`, `running`, atau `integrating` tetapi proses pemilik tidak ada THEN sistem SHALL menandainya `interrupted`.
33. IF candidate branch dan candidate SHA masih valid setelah restart THEN sistem SHALL memulihkan task sebagai candidate yang dapat direview.
34. IF worktree tersisa dan perubahan belum mempunyai candidate ref THEN sistem SHALL menandainya `recovery_required` dan tidak melakukan prune otomatis.
35. WHEN task dipulihkan THEN sistem SHALL tidak menjalankan ulang agent secara otomatis tanpa tindakan operator.

### FR-7 — Human Approval

36. WHEN candidate siap THEN sistem SHALL menampilkan objective, candidate branch, immutable SHA, target branch, target SHA, changed files, dan validation evidence.
37. WHEN integrasi diminta dalam mode interaktif THEN sistem SHALL menampilkan confirmation dialog kepada user.
38. IF sistem berjalan tanpa UI interaktif THEN sistem SHALL mengizinkan pembuatan candidate tetapi menolak integrasi otomatis.
39. WHEN user menyetujui candidate THEN sistem SHALL mengikat approval pada task ID, candidate SHA, target branch, dan target SHA yang ditampilkan.
40. IF salah satu nilai yang disetujui berubah sebelum integrasi THEN sistem SHALL membatalkan approval sebagai stale.
41. WHEN user menolak candidate THEN sistem SHALL menandai task `rejected` tanpa otomatis menghapus branch.

### FR-8 — Integration

42. WHEN candidate approved akan diintegrasikan THEN sistem SHALL memastikan checkout utama bersih dan berada pada target branch yang disetujui.
43. WHEN integrasi dimulai THEN sistem SHALL melakukan merge yang dapat dibatalkan sebelum membuat commit final.
44. IF merge menghasilkan conflict THEN sistem SHALL membatalkan merge, mempertahankan candidate branch, dan menandai `integration_conflict`.
45. IF validation integrasi gagal THEN sistem SHALL membatalkan integrasi dan mempertahankan candidate branch.
46. WHEN integrasi dan validation berhasil THEN sistem SHALL membuat commit integrasi dan menandai task `integrated`.
47. WHEN task telah integrated atau rejected THEN sistem SHALL tidak menghapus candidate branch tanpa konfirmasi destructive terpisah.

### FR-9 — Observability

48. WHEN task aktif atau candidate tertunda tersedia THEN sistem SHALL menampilkannya pada fleet/task UI terlepas dari apakah `AgentRecord` masih berada di memory.
49. WHEN task dilihat THEN sistem SHALL membedakan status proses agent, status validation, status candidate, dan status delivery.
50. WHEN recovery atau preservation failure terjadi THEN sistem SHALL menampilkan lokasi artifact yang masih dapat dipulihkan dan alasan kegagalan.
51. WHEN task berpindah state THEN sistem SHALL menerbitkan lifecycle event tanpa memerlukan polling agent.
52. WHILE tidak ada lifecycle event THEN sistem SHALL tidak menjalankan polling LLM untuk menentukan status task.

## Non-functional Requirements

### NFR-1 — Safety

53. IF operasi Git gagal pada tahap apa pun THEN sistem SHALL gagal tertutup dan tidak menyatakan task berhasil.
54. IF pekerjaan belum mempunyai Git ref yang terverifikasi THEN sistem SHALL tidak menghapus worktree secara otomatis.
55. WHEN command Git dijalankan THEN sistem SHALL menggunakan argument array dan tidak membentuk shell command dari nama branch atau path.
56. WHEN approval diperlukan THEN keputusan model, output agent, tool result, atau validation evidence SHALL NOT dianggap sebagai approval user.
57. WHEN main checkout kotor THEN sistem SHALL tidak melakukan spawn `ship` atau integrasi.

### NFR-2 — Reliability

58. WHEN snapshot task disimpan THEN sistem SHALL menggunakan atomic replacement.
59. WHEN operasi persistence gagal THEN sistem SHALL melaporkan kegagalan dan tidak melanjutkan ke state yang membutuhkan durability.
60. WHEN startup reconciliation dijalankan berulang kali THEN hasilnya SHALL idempotent.
61. WHEN cleanup dipanggil lebih dari sekali THEN sistem SHALL tidak menghapus candidate ref atau mengubah terminal outcome yang valid.
62. WHEN Pi restart THEN candidate yang sudah dipreservasi SHALL tetap dapat di-review tanpa mengandalkan memory process lama.

### NFR-3 — Compatibility

63. WHERE Agent Control dinonaktifkan THEN existing `Agent` behavior SHALL tetap kompatibel.
64. WHERE Agent Control aktif untuk top-level `Agent` THEN workflow, nested agent, mention, dan RPC SHALL mempertahankan behavior legacy sampai dimigrasikan secara eksplisit.
65. WHEN custom agent lama tidak mempunyai task policy dan Agent Control tidak aktif THEN sistem SHALL tetap memuat agent tersebut.
66. WHEN feature rollout dilakukan THEN sistem SHALL dapat diaktifkan per project.

### NFR-4 — Performance

67. WHEN state task berubah THEN persistence SHALL tidak memblokir event loop selama operasi Git atau filesystem yang lambat.
68. WHEN beberapa task independen dimulai THEN worktree creation SHALL tetap asynchronous dan dapat berjalan sesuai concurrency limit.
69. WHEN startup reconciliation dijalankan THEN sistem SHALL hanya memeriksa state repository aktif dan tidak memindai seluruh filesystem.

### NFR-5 — Security and Privacy

70. WHEN task state dipersist THEN sistem SHALL tidak menyimpan credential, environment variable value, atau secret hasil tool.
71. WHEN validation output disimpan THEN sistem SHALL membatasi ukuran dan melakukan redaction terhadap pola secret yang dikenal.
72. WHEN state disimpan THEN data SHALL berada di storage lokal yang tidak masuk version control.
73. WHEN path dari persisted state digunakan THEN sistem SHALL memverifikasi bahwa path masih berada dalam repository atau worktree yang diharapkan.

## Acceptance Criteria

1. **WHEN** `explore` dipanggil dalam Agent Control **THEN** sistem SHALL menjalankan task read-only tanpa worktree dan tanpa write-capable tools.
2. **WHEN** `build` dipanggil dalam Agent Control **THEN** sistem SHALL membuat durable `ship` task dan worktree sebelum agent berjalan.
3. **WHEN** `general` dipanggil tanpa task mode **THEN** sistem SHALL menolak spawn sebelum membuat record atau worktree.
4. **IF** repository kotor **THEN** sistem SHALL menolak `ship` tanpa mengubah stash, index, HEAD, atau working tree.
5. **IF** worktree creation gagal **THEN** sistem SHALL menandai task gagal dan SHALL NOT menjalankan agent di checkout utama.
6. **IF** preservation commit gagal **THEN** sistem SHALL mempertahankan worktree dan melaporkan `preservation_failed`.
7. **WHEN** agent mengubah file di luar declared scope **THEN** sistem SHALL mempertahankan artifact tetapi tidak membuat candidate yang dapat disetujui.
8. **WHEN** validation command gagal **THEN** sistem SHALL menyimpan evidence, mempertahankan artifact, dan menandai `validation_failed`.
9. **WHEN** semua validation dan scope check berhasil **THEN** sistem SHALL membuat candidate branch dengan immutable head SHA.
10. **WHEN** Pi dimulai ulang setelah candidate dibuat **THEN** candidate SHALL muncul kembali dengan SHA dan evidence yang sama.
11. **WHEN** Pi dimulai ulang ketika task masih `running` **THEN** task SHALL menjadi `interrupted` dan tidak dijalankan ulang otomatis.
12. **IF** orphan worktree mempunyai perubahan tanpa candidate ref **THEN** sistem SHALL menandai `recovery_required` dan tidak menghapusnya.
13. **WHEN** user membuka candidate **THEN** sistem SHALL menampilkan target, changed files, validation evidence, dan immutable SHA.
14. **IF** mode tidak interaktif **THEN** sistem SHALL menolak integrasi tetapi tetap menyediakan candidate branch.
15. **WHEN** user menyetujui candidate dan Git state tetap sesuai **THEN** sistem SHALL mengintegrasikan perubahan dan menandai `integrated`.
16. **IF** candidate SHA atau target SHA berubah setelah approval **THEN** sistem SHALL menolak integrasi sebagai stale approval.
17. **IF** merge conflict terjadi **THEN** sistem SHALL mengembalikan checkout ke pre-merge state dan mempertahankan candidate branch.
18. **IF** post-merge validation gagal **THEN** sistem SHALL membatalkan integrasi dan mempertahankan candidate branch.
19. **WHEN** candidate ditolak **THEN** sistem SHALL mempertahankan branch sampai user mengonfirmasi penghapusan terpisah.
20. **WHERE** Agent Control dinonaktifkan **THEN** existing Agent tests dan behavior SHALL tetap lolos tanpa migrasi konfigurasi.
21. **WHEN** dua task `ship` dengan scope tumpang tindih diminta **THEN** sistem SHALL memblokir task kedua sampai konflik scope diselesaikan atau user memberi override.
22. **WHEN** persistence gagal **THEN** sistem SHALL tidak melanjutkan task ke `running`, `candidate_ready`, atau `integrated`.
23. **WHEN** lifecycle task berubah **THEN** UI dan event consumer SHALL memperoleh status dari durable state tanpa polling LLM.
24. **WHEN** task terminal keluar dari in-memory Agent registry **THEN** candidate dan delivery status SHALL tetap tersedia dari durable task store.

## Implementation Decisions

### Final

- Agent Control diterapkan pada top-level `Agent` terlebih dahulu.
- `explore` menggunakan policy `scout`.
- `build` menggunakan policy `ship`.
- `general` menggunakan policy `flexible` dan memerlukan task mode eksplisit.
- Task `ship` wajib memakai Git worktree.
- Checkout kotor memblokir task `ship`; sistem tidak membuat stash atau WIP commit.
- Candidate disimpan sebagai Git branch dan immutable commit SHA.
- Integrasi memerlukan approval user melalui UI interaktif.
- Mode headless hanya dapat menghasilkan candidate.
- State disimpan lokal per repository di Git common storage dan tidak masuk version control.
- Recovery startup bersifat reconcile-and-pause, bukan auto-resume.
- Candidate branch tidak dihapus otomatis.
- Workflow, nested agent, mention, dan RPC berada di luar rollout pertama.
- Lifecycle memakai event internal; tidak memakai watcher Bash atau polling LLM.

### Resolved in v1.1.0

- Task `ship` boleh mempunyai 1 sampai 5 validation commands; commands dijalankan secara sequential dan fail-fast.
- Scope overlap diblokir secara default; hanya approval manusia eksplisit yang dapat memberi override. Model atau output agent tidak dapat memberi override.
- Integration validation menjalankan ulang daftar validation commands kandidat yang sama; MVP tidak mempunyai daftar command project-level terpisah.
- Metadata task, event history, dan candidate tidak mempunyai auto-expiry atau auto-pruning. Cleanup hanya melalui tindakan administratif eksplisit.
- Rejected candidate branch dipertahankan dan belum dapat dihapus melalui UI MVP. Penghapusan, jika diperlukan, adalah tindakan administratif eksplisit.

## Testing Decisions

- **Seam utama:** lifecycle spawn/settle pada `AgentManager`; sudah mempunyai callback dan dapat diuji dengan runner palsu.
- **Seam kedua:** resolver konfigurasi invocation; pure function yang cocok untuk policy resolution dan conflict validation.
- **Seam ketiga:** fungsi worktree create/finalize/prune; sudah dipisahkan dari manager dan Git execution dapat diganti dengan fake `ExtensionAPI`.
- **Test strategy:** unit test state machine, store, policy, redaction, dan approval binding; integration test worktree/validation/recovery; wiring test top-level Agent dan UI confirmation; regression test untuk mode legacy.
- **Environment:** Windows menjadi environment wajib karena worktree cleanup dan filesystem rename mempunyai perilaku khusus; test Git real-repository tetap dipertahankan.
- **Coverage target:** setiap transition state, failure branch yang dapat kehilangan pekerjaan, dan approval stale condition harus mempunyai minimal satu test otomatis.

## Out of Scope

- Durable orchestration untuk `SubagentWorkflow`.
- Task DAG dan dependency scheduler.
- Nested-agent task control.
- Cross-extension RPC task control.
- Remote worker, SSH, dan multi-host state.
- Auto-merge atau merge tanpa approval.
- Pull request automation.
- Automatic conflict resolution.
- Automatic stash atau WIP commit.
- Automatic deletion of candidate branches.
- Continuous Bash watcher.
- Resume workflow journal lintas sesi.
