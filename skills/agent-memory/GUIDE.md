# Panduan agent-memory lintas OS

Satu vault Obsidian untuk semua agent (Pi, Claude Code, Codex) di semua device.
Source skill ini ikut tersinkron lewat Google Drive, jadi setup per device hanya sekali.

## 1. Syarat (semua OS)

- Python 3.10+ (`python3 --version`)
- Google Drive tersinkron, berisi folder `AGENT-MEMORY/` (vault `pi-memory` + `agent-memory-skill`)
- Linux tanpa Drive resmi: mount dulu (mis. `rclone`), lalu set `AGENT_MEMORY_VAULT` ke path mount

## 2. Install

Buka folder skill di Drive, lalu:

**macOS / Linux** — di `AGENT-MEMORY/agent-memory-skill/`:

```sh
./install.sh
```

**Windows** — PowerShell, di `G:\My Drive\AGENT-MEMORY\agent-memory-skill\`:

```powershell
.\install.ps1
```

Installer melakukan: symlink skill, command `memory` di PATH, hook SessionStart di Claude/Codex, salin extension Pi. Idempoten, aman diulang.

## 3. Verifikasi

```sh
memory status
```

Harus tampil: path vault, project terdeteksi, jumlah note. Kalau `vault tidak ditemukan`, set manual:

```sh
# macOS/Linux (~/.zshrc, ~/.bashrc)
export AGENT_MEMORY_VAULT="$HOME/GoogleDrive/AGENT-MEMORY/pi-memory"
```

```powershell
# Windows (PowerShell, sekali saja)
[Environment]::SetEnvironmentVariable("AGENT_MEMORY_VAULT", "G:\My Drive\AGENT-MEMORY\pi-memory", "User")
```

## 4. Setelah install

- **Pi**: restart sekali (memuat extension + AGENTS.md baru).
- **Codex**: sesi pertama minta "Trust all and continue" untuk hook baru — setujui.
- **Claude**: tidak ada langkah tambahan.

## 5. Pakai harian

| Perlu | Command |
|---|---|
| Brief awal sesi (biasanya otomatis dari hook) | `memory brief` |
| Cari pengetahuan lama | `memory search "kata kunci"` |
| Baca detail | `memory read <path> [--section "Nama"]` |
| Simpan keputusan/fakta | `memory save --type decision\|note --title "..."` + isi via heredoc/stdin (`--section` untuk ubah section, `--replace-body` bila menimpa penuh) |
| Estafet kerja antar sesi/agent | `memory handoff` (+ heredoc), lalu `memory handoff --claim` |
| Cek kesehatan vault | `memory lint` |
| Rapikan (hanya bila diminta) | `memory review` → rencana → konfirmasi → `memory move` (termasuk ke `.trash/`) → `memory lint` |

Aturan lengkap ada di `SKILL.md` (dibaca otomatis oleh agent).

## 6. Masalah umum

- `vault tidak ditemukan` → langkah 3.
- Hook gagal di Windows → ganti command hook jadi `py -3 "<path-skill>\memory.py" brief --max-tokens 300`.
- Brief tidak muncul → `memory status`, cek project terdeteksi.
- Detail ada di `SKILL.md` bagian Troubleshooting.
