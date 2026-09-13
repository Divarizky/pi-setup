# Agent Control

Panduan penggunaan Agent Control untuk top-level `Agent`.

## 1. Aktivasi per project

Agent Control nonaktif secara default untuk mempertahankan behavior legacy.

Tambahkan ke project settings `.pi/subagents.json`:

```json
{
  "agentControl": true
}
```

Catatan migrasi:

- Setting lama `firstmateLite` masih dibaca.
- Penulisan baru memakai `agentControl`.
- Menonaktifkan kembali cukup dengan `"agentControl": false`.

## 2. Task mode

### `explore`: scout read-only

- Tidak membuat worktree.
- Tidak menghasilkan candidate branch.
- Cocok untuk investigasi repository.

```js
Agent({
  subagent_type: "explore",
  description: "Find auth entry points",
  prompt: "Find every authentication entry point"
})
```

### `build`: ship task terisolasi

Wajib menyertakan 1–5 `validation_commands`:

```js
Agent({
  subagent_type: "build",
  description: "Implement task control",
  prompt: "Implement immutable approval binding",
  validation_commands: ["npm.cmd test -- --run test/task-view.test.ts"]
})
```

Tanpa validation commands, ship preflight gagal sebelum task berjalan.

### `general`: wajib memilih mode eksplisit

```js
Agent({
  subagent_type: "general",
  description: "Research task",
  prompt: "...",
  task_mode: "scout"
})
```

atau:

```js
Agent({
  subagent_type: "general",
  description: "Delivery task",
  prompt: "...",
  task_mode: "ship",
  validation_commands: ["npm.cmd run lint"]
})
```

Nilai `task_mode` yang valid hanya `"scout"` atau `"ship"`.

## 3. Menjalankan task

- Task scout berjalan tanpa branch candidate.
- Task ship berjalan di Git worktree terisolasi.
- Checkout kotor memblokir ship.
- Sistem tidak membuat stash, WIP commit, atau cleanup otomatis.
- Scope `ship` yang tumpang tindih diblokir secara default.
- Hanya override eksplisit dari user yang dapat meloloskan overlap.

Contoh yang akan gagal preflight:

```js
Agent({
  subagent_type: "build",
  description: "Missing validation",
  prompt: "Do work without validation evidence"
})
```

## 4. Membuka review candidate

Gunakan salah satu cara berikut:

- Buka `/agents`, pilih **Agent Control tasks**.
- Gunakan tool `agent_control_tasks`.

Contoh membaca satu task:

```js
agent_control_tasks({
  action: "get",
  task_id: "task-123"
})
```

Review menampilkan:

- objective
- status task
- target branch dan SHA
- candidate branch dan SHA
- changed files
- validation evidence
- status approval
- integration commit bila sudah integrated

## 5. Approve atau reject dari UI

- Approve dan reject tersedia untuk task `candidate_ready`.
- Konfirmasi dialog dari user bersifat wajib.
- Output model atau agent tidak dapat menggantikan persetujuan user.
- Approval terikat immutable ke:
  - task ID
  - candidate branch
  - candidate SHA
  - target branch
  - target SHA
- Jika candidate atau target berubah setelah approval, integrasi ditolak sebagai stale.
- Reject mempertahankan candidate branch.
- Approval dan rejection tetap tersedia setelah restart.

## 6. Integrasi candidate yang sudah approved

Pilih aksi `[i] integrate` pada task yang sudah approved.

Alur integrasi:

1. Clean checkout preflight.
2. Verifikasi ulang target SHA.
3. Verifikasi ulang candidate branch dan SHA.
4. Merge abortable `--no-ff --no-commit`.
5. Menjalankan ulang validation commands kandidat yang sama.
6. Rollback bila terjadi conflict atau validasi gagal.
7. Membuat integration commit bila semua lolos.

Hasil akhir:

- Sukses: status `integrated` beserta SHA integration commit.
- Conflict: checkout dikembalikan ke pre-merge state.
- Validasi gagal: tidak ada integration commit.
- Candidate branch tetap ada pada semua failure path.

## 7. Mode headless

- Candidate tetap dapat dibaca.
- Integration ditolak tanpa mengubah repository.
- Review candidate bersifat read-only.

## 8. Storage dan recovery

- State durable disimpan di Git common directory repository, folder `agent-control/`.
- Candidate branch tidak dihapus otomatis.
- Task `running` menjadi `interrupted` setelah restart.
- Tidak ada auto-restart agent.
- Tidak ada pruning otomatis.
- Penghapusan candidate branch, bila diperlukan, adalah tindakan administratif manual.

## 9. Batasan rollout saat ini

Di luar cakupan Agent Control tahap ini:

- Durable orchestration untuk `SubagentWorkflow`.
- Task DAG dan dependency scheduler.
- Nested-agent task control.
- Cross-extension RPC task control.
- Remote worker, SSH, dan multi-host state.
- Auto-merge tanpa approval.
- Pull request automation.
- Automatic conflict resolution.
- Continuous filesystem atau Bash watcher.
