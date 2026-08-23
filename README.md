# pi-setup

Personal Pi Coding Agent setup. Instalasi global Pi berada di `~/.pi/agent` (atau `PI_CODING_AGENT_DIR` jika dioverride).

## What's Included

**Extensions (9)**
- `9router` — 9Router provider integration (login, status, model sync)
- `ask-user` — Multiple choice questions for the model
- `copy-all` — Copy conversation to clipboard
- `git-info` — Git branch, changes, PR status in footer
- `run-summaries` — Auto-summarize agent runs
- `subagents` — Background Pi subagents with orchestration
- `todos` — Todo tracking with overlay widget
- `ui-customization` — Custom header/footer, theme tweaks
- `usage-tracker` — Provider quota & session usage dashboard

**Skills (13)**
- `ask-me` — Grill + router (main entry for ambiguous requests)
- `bug-diagnosis` — 6-phase disciplined bug diagnosis
- `code-review` — Dual-axis review (Standards + Spec)
- `git-commit` — Conventional commits with review gate
- `handoff` — Context handoff between sessions/agents
- `implement` — TDD implementation with code-review chain
- `improve-architecture` — Deepening scan + interview
- `project-migration` — Legacy→new project migration
- `prototype` — Throwaway prototypes (LOGIC/UI)
- `setup-workflow` — Initialize `.workspace/` for project-aware mode
- `status` — Snapshot current workflow state
- `to-issues` — Breakdown PRD/plan into vertical-slice tasks
- `to-prd` — Synthesize conversation/grill into PRD

`dashboard-state` adalah modul internal yang dipakai bersama oleh `git-info`, `ui-customization`, dan `usage-tracker`; bukan extension user-facing terpisah.

## Quick Start

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.ps1 | iex
```

### macOS/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.sh | bash
```

Installer menempatkan resource runtime Pi (`extensions/`, `skills/`, `prompts/`, dan `node_modules/`) ke root agent Pi, tanpa metadata Git atau file setup repository. State pribadi tetap dipertahankan. Untuk direktori lama, gunakan mode repair di [SETUP.md](SETUP.md).

### Instal manual

```bash
git clone https://github.com/Divarizky/pi-setup.git ~/.pi/agent
cd ~/.pi/agent
npm ci
```

Restart Pi setelah instalasi.

## Project-Aware Mode

For persistence across sessions, run `setup-workflow` once per repo:

```
/setup-workflow
```

This creates `.workspace/` with:
- `context/AGENT.md` — Quick references
- `context/CONTEXT.md` — Full detail
- `context/ADR.md` — Architecture decisions
- `tracking/issue-tracker.md` — Feature index
- `.scratch/<slug>/` — Per-feature PRD, tasks, prototypes

Universal mode works without setup — context stays in chat.

## Extensions Development

Each extension in `extensions/` is a standalone TypeScript module. See `extensions/<name>/` for structure.