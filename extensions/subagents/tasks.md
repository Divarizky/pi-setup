# Agent Control Plane — Tasks

Requirements: `requirements.md` v1.1.0 (`approved`)

## Queue

## In Progress

## Done

- [x] TASK-10 | Harden rollout and regression coverage | Depends: TASK-3, TASK-4, TASK-5, TASK-6, TASK-7, TASK-8, TASK-9 | Priority: high | Parallel: no
    Ref: AC 20, 22, 23, 24
    Detail: Lengkapi regression suite, redaction dan path validation, project settings, migration boundaries, serta dokumentasi penggunaan Agent Control untuk top-level `Agent`. Pastikan rollout dapat diaktifkan per project tanpa mengubah jalur workflow, RPC, mentions, atau nested agents.
    Done:
    - [x] Lint, typecheck, unit tests, integration tests, dan build lolos.
    - [x] Legacy mode mempertahankan behavior sebelumnya.
    - [x] Workflow, RPC, mentions, dan nested-agent behavior tidak berubah.
    - [x] Persisted output meredact secret dan menolak path di luar repository.
    - [x] Agent Control dapat diaktifkan dan dimatikan per project.


- [x] TASK-9 | Integrate approved candidates transactionally | Depends: TASK-1, TASK-8 | Priority: critical | Parallel: no
    Ref: AC 15, 17, 18
    Detail: Integrasikan candidate yang disetujui dengan clean-checkout preflight, abortable merge, pengulangan validation commands kandidat yang sama, dan rollback pada conflict atau validation failure. Hanya exact candidate yang disetujui user yang boleh mencapai integration commit.
    Done:
    - [x] Hanya exact approved candidate yang dapat diintegrasikan.
    - [x] Merge conflict mengembalikan checkout ke pre-merge state.
    - [x] Failed integration validation tidak menghasilkan integration commit.
    - [x] Candidate branch tetap ada pada semua failure path.
    - [x] Successful integration menghasilkan commit dan status `integrated`.


- [x] TASK-8 | Bind human approval to immutable state | Depends: TASK-1, TASK-7 | Priority: critical | Parallel: no
    Ref: AC 16, 19
    Detail: Tambahkan confirmation dialog untuk approve atau reject candidate. Approval harus terikat pada task, candidate SHA, target branch, dan target SHA; perubahan salah satu nilai membuat approval stale sebelum Git mutation dilakukan.
    Done:
    - [x] Tidak ada output agent atau model tool call yang dapat menggantikan dialog user.
    - [x] Stale candidate atau target SHA ditolak sebelum Git mutation.
    - [x] Reject mempertahankan candidate branch.
    - [x] Approval dan rejection tetap tersedia setelah restart.


- [x] TASK-7 | Review candidates across runtime modes | Depends: TASK-5, TASK-6 | Priority: critical | Parallel: no
    Ref: AC 13, 14, 23, 24
    Detail: Tambahkan task dan candidate view yang membaca durable store, menampilkan delivery evidence, dan tetap tersedia setelah AgentRecord dihapus. Mode headless hanya dapat membaca candidate dan menolak integrasi tanpa mengubah repository.
    Done:
    - [x] UI menampilkan objective, target branch/SHA, candidate branch/SHA, changed files, validation evidence, serta status process/validation/candidate/delivery.
    - [x] Candidate tetap terlihat setelah in-memory record dibersihkan.
    - [x] Headless integration ditolak tanpa mengubah repository.
    - [x] UI berubah melalui lifecycle event, bukan polling LLM.

- [x] TASK-6 | Recover tasks after restart | Depends: TASK-5 | Priority: critical | Parallel: no
    Ref: AC 10, 11, 12, 24
    Detail: Muat durable task saat session start, reconcile Git refs dan worktrees, ubah proses yang hilang menjadi interrupted, dan pulihkan candidate tanpa menjalankan agent kembali secara otomatis. Reconciliation harus aman dipanggil berulang kali.
    Done:
    - [x] Reconciliation berulang menghasilkan state yang sama.
    - [x] Valid candidate muncul kembali dengan SHA dan evidence yang sama.
    - [x] In-flight task menjadi interrupted tanpa menjalankan agent ulang.
    - [x] Orphan worktree dengan perubahan menjadi `recovery_required` dan tidak dipruned.

- [x] TASK-5 | Produce validated candidate branches | Depends: TASK-1, TASK-4 | Priority: critical | Parallel: no
    Ref: AC 7, 8, 9
    Detail: Jalankan scope check dan 1 sampai 5 validation commands secara sequential fail-fast di worktree, simpan redacted execution evidence, lalu hasilkan immutable candidate branch hanya ketika semua checks berhasil. Integration validation akan mengulang daftar command kandidat yang sama; semua failure path harus mempertahankan pekerjaan melalui worktree atau verified Git ref.
    Done:
    - [x] Out-of-scope changes dan failed atau timeout validation tidak dapat menjadi approvable candidate.
    - [x] Artifact gagal tetap mempunyai worktree atau verified Git ref yang dapat dipulihkan.
    - [x] Candidate sukses menyimpan branch, immutable SHA, changed files, dan validation evidence.
    - [x] Claim agent tanpa execution evidence tidak dihitung sebagai validation success.

- [x] TASK-4 | Start isolated ship tasks safely | Depends: TASK-2, TASK-3 | Priority: critical | Parallel: no
    Ref: AC 2, 4, 5, 21, 22
    Detail: Jadikan `build` sebagai ship policy, lakukan Git cleanliness dan base preflight, rekam task contract, cek active write scopes, lalu buat worktree sebelum agent berjalan. Semua preflight failure harus berhenti sebelum agent dapat menulis ke checkout utama; scope overlap hanya dapat dilanjutkan setelah override manusia eksplisit.
    Done:
    - [x] `build` tidak dapat berjalan di checkout utama saat Agent Control aktif.
    - [x] Dirty checkout, missing HEAD, disabled worktree, dan overlapping scope tanpa override manusia gagal sebelum agent berjalan.
    - [x] Kegagalan persistence tidak membiarkan task masuk `running`.
    - [x] Preflight tidak mengubah stash, index, HEAD, atau working tree.

- [x] TASK-3 | Deliver durable scout tasks | Depends: TASK-1 | Priority: critical | Parallel: no
    Ref: AC 1, 3, 20, 22, 23
    Detail: Tambahkan feature flag Agent Control, task state machine, atomic repository-local store, event journal, dan policy resolver. Hubungkan top-level `Agent` agar `explore` menjadi durable scout dan `general` memerlukan task mode eksplisit, sementara mode legacy tetap kompatibel.
    Done:
    - [x] `explore` berjalan tanpa write-capable tools dan tidak membuat worktree.
    - [x] `general` tanpa task mode ditolak sebelum AgentRecord dibuat.
    - [x] Scout completion dan failure tersimpan serta menerbitkan lifecycle event.
    - [x] Mode legacy tetap lulus regression tests saat feature flag mati.


- [x] TASK-2 | Preserve worktree changes losslessly | Depends: none | Priority: critical | Parallel: yes
    Ref: AC 5, 6, 9
    Detail: Ubah finalisasi worktree agar membedakan clean result, verified candidate, dan preservation failure. Commit atau branch failure harus mempertahankan worktree serta memberikan error yang dapat dipulihkan, bukan hasil seolah-olah tidak ada perubahan.
    Done:
    - [x] Commit failure dan branch failure tidak menghapus worktree atau melaporkan `no changes`.
    - [x] Candidate SHA diverifikasi sebelum worktree dihapus.
    - [x] Existing worktree tests dan failure-path tests lolos pada Windows.

- [x] TASK-1 | Prototype unresolved delivery policies | Depends: none | Priority: critical | Parallel: no
    Ref: AC 8, 15, 18, 19, 21
    Detail: Buat prototype logic dan executable decision matrix untuk jumlah dan perilaku validation commands, scope-overlap handling, integration validation, retention, serta rejected-branch lifecycle. Gunakan hasilnya untuk mengunci pilihan sebelum production implementation bergantung padanya. Task ini memiliki uncertainty tinggi dan tidak boleh meneruskan behavior ambigu ke slice berikutnya.
    Done:
    - [x] Setiap open decision mempunyai minimal dua skenario test dan satu keputusan terpilih.
    - [x] Keputusan final disinkronkan ke `requirements.md` v1.1.0 tanpa memperluas scope fitur.
    - [x] Tidak ada placeholder atau behavior ambigu yang diteruskan ke task berikutnya.
