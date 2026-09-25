# pi-setup

Personal Pi Coding Agent setup. Instalasi global Pi berada di `~/.pi/agent` (atau `PI_CODING_AGENT_DIR` jika dioverride).

## What's Included

**Extensions (10)**
- `9router` — 9Router provider integration (login, status, model sync)
- `ask-user` — Multiple choice questions for the model
- `context-manager` — Session context tracking, large-output caching/pruning, and execute/inspect tools (no confirmation prompt)
- `copy-all` — Copy conversation to clipboard
- `git-info` — Git branch, changes, PR status in footer
- `run-summaries` — Auto-summarize agent runs
- `subagents` — Background Pi subagents, workflows, worktrees, and Agent Control (v2)
- `todos` — Todo tracking with overlay widget
- `ui-customization` — Custom header/footer, theme tweaks, memory status
- `usage-tracker` — Provider quota & session usage dashboard

**Skills (14)**
- `ask-me` — Grill + router (main entry for ambiguous requests)
- `bug-diagnosis` — 6-phase disciplined bug diagnosis
- `code-review` — Dual-axis review (Standards + Spec)
- `git-commit` — Conventional commits with review gate
- `handoff` — Context handoff between sessions/agents
- `humanize` — Manual-only prose rewrites that preserve meaning
- `implement` — TDD implementation with code-review chain
- `improve-architecture` — Deepening scan + interview
- `project-migration` — Project migration workflow
- `prototype` — Throwaway prototypes (LOGIC/UI)
- `setup-workflow` — Initialize `.workspace/` for project-aware mode
- `status` — Snapshot current workflow state
- `to-requirements` — Synthesize approved requirements into SRS and feature work cards
- `to-tasks` — Break approved feature work into vertical-slice tasks

**Themes (3)**
- `catppuccin-mocha` — tema Mocha
- `github-dark-default` — tema aktif saat ini (lihat `settings.json`)
- `urple` — varian ungu gelap

`dashboard-state` adalah modul internal yang dipakai bersama oleh `git-info`, `ui-customization`, dan `usage-tracker`; bukan extension user-facing terpisah.

Setup aktif juga memakai skill eksternal dari `.agents/skills` (`computer-use`, `find-skills`, `orca-cli`, dan `orchestration`). Skill eksternal tersebut sengaja tidak divendor ke repo ini.

## Quick Start

### Windows PowerShell

```powershell
$script = Join-Path $env:TEMP "pi-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.ps1 -OutFile $script
& $script
```

### macOS/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.sh -o /tmp/pi-install.sh
bash /tmp/pi-install.sh
```

Installer menempatkan resource runtime Pi (`extensions/`, `skills/`, `prompts/`, `themes/`, dan `node_modules/`) ke root agent Pi, tanpa metadata Git atau file setup repository. State pribadi tetap dipertahankan. Skill eksternal dari `.agents/skills` dan package Pi tambahan dikelola terpisah. Untuk direktori lama, gunakan mode repair di [SETUP.md](SETUP.md).

### Instal manual

```bash
git clone https://github.com/Divarizky/pi-setup.git ~/.pi/agent
cd ~/.pi/agent
npm ci
```

Restart Pi setelah instalasi.

## Project Mode

For persistence across sessions, run `setup-workflow` once per repo:

```
/setup-workflow
```

This creates the current `.workspace/` structure:
- `project-meta.md` — Setup and refresh metadata
- `context/PROJECT.md` — Quick references
- `context/CONTEXT.md` — Domain and technical detail
- `context/SRS.md` — Approved requirements and feature registry
- `context/TRACKER.md` — Feature execution progress
- `work/F-<id>.md` — Per-feature work card

Universal mode works without setup — context stays in chat.

## Extensions Development

Each extension in `extensions/` is a standalone TypeScript module. See `extensions/<name>/` for structure. `subagents` saat ini versi `2.0.0`, memakai Biome dan test suite sendiri. Extension yang dikelola Orca berada di `extensions/orca-*.ts` dan membutuhkan host Orca/Pi yang sesuai.