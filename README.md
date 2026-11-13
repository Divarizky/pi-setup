# pi-setup

Personal Pi Coding Agent setup. Instalasi global Pi berada di `~/.pi/agent` (atau `PI_CODING_AGENT_DIR` jika dioverride).

## What's Included

**Extensions (13)**

- `agent-memory` — Injeksi read-only `memory brief` ke system prompt dari vault Obsidian bersama (via skill `agent-memory`)
- `ask-user` — Multiple choice questions for the model
- `code-safety` — Perlindungan keamanan eksekusi dan integritas kode: modul `hash-edit` (anchor SHA-256), `conflict-resolver` (resolusi merge hunk interaktif), `failure-recovery` (eskalasi retry otomatis), dan `ttsr` (Two-Turn System Rules guard & stream interceptor)
- `context-manager` — Session context tracking, large-output caching/pruning, output-frame, dan execute/inspect tools
- `copy-all` — Copy conversation to clipboard
- `git-info` — Git branch, changes, PR status in footer
- `run-summaries` — Auto-summarize agent runs
- `subagents` — Background Pi subagents, workflows, worktrees, dan Agent Control (v2) dengan display name `General`
- `todos` — Todo tracking dengan overlay widget, verifikasi modifikasi kode otomatis via task-judge terintegrasi, dan inactivity nudge
- `ui-customization` — Custom tool rendering (read, bash, edit, write), thinking shimmer, working message, header/footer, dan penyesuaian tema
- `usage-tracker` — Provider quota & session usage dashboard (Claude CLI OAuth, 9Router, Codex, Zen)
- `zenith-router` — Integrasi provider Zenith Router, gateway status reporter, dan publisher quota untuk usage-tracker

**Skills (17)**

- `ask-me` — Grill + router (main entry for ambiguous requests)
- `bug-diagnosis` — 6-phase disciplined bug diagnosis
- `code-review` — Dual-axis review (Standards + Spec)
- `git-commit` — Conventional commits with review gate
- `github-issue` — Pembuatan issue GitHub terstruktur dari task, requirement, atau bug diagnosis
- `handoff` — Context handoff between sessions/agents
- `humanize` — Manual-only prose rewrites that preserve meaning
- `implement` — TDD implementation with code-review chain
- `improve-architecture` — Deepening scan + interview
- `merge-conflict` — Resolusi konflik Git terstruktur dan aman
- `project-migration` — Project migration workflow
- `prompt-authoring` — Panduan menulis teks instruksi untuk LLM: AGENTS.md, SYSTEM.md, SKILL.md, prompt template, deskripsi tool
- `prototype` — Throwaway prototypes (LOGIC/UI)
- `setup-workflow` — Initialize `.workspace/` for project-aware mode
- `status` — Snapshot current workflow state
- `to-requirements` — Synthesize approved requirements into SRS and feature work cards
- `to-tasks` — Break approved feature work into vertical-slice tasks

**Identity (referensi)**

- `identity/` — Arsip `AGENTS.md` dan `SOUL.md` sebelum digabung. Hanya referensi, tidak ikut dideploy oleh installer.

### Dev Workflow Architecture

```mermaid
flowchart TD
    classDef gate fill:#f97316,stroke:#c2410c,stroke-width:2px,color:#fff;
    classDef review fill:#8b5cf6,stroke:#6d28d9,stroke-width:2px,color:#fff;
    classDef build fill:#0284c7,stroke:#0369a1,stroke-width:2px,color:#fff;
    classDef context fill:#059669,stroke:#047857,stroke-width:2px,color:#fff;

    USER([Developer Request]) --> ASK[ask-me<br/><i>Intent Router + Grill 3-5 Qs</i>]:::gate

    %% Cabang Alur
    ASK -->|Fitur Besar| REQ[to-requirements<br/><i>EARS + Work Card F-id</i>]:::build
    ASK -->|Fitur Kecil| IMP[implement<br/><i>TDD Red-Green-Refactor</i>]:::build
    ASK -->|Bug Sulit| BUG[bug-diagnosis<br/><i>Vertical Repro + RCA</i>]:::build
    ASK -->|Desain Ragu| PROTO[prototype<br/><i>LOGIC / UI Spike</i>]:::build
    ASK -->|Debt / Coupling| ARCH[improve-architecture<br/><i>Audit & Refactor Scan</i>]:::build
    ASK -->|Conflict Aktif| CONF[merge-conflict<br/><i>Guided Hunk Resolution</i>]:::build
    ASK -->|Migrasi Codebase| SETUP[setup-workflow<br/><i>Init AGENTS + Context</i>]:::context

    %% Pipeline Spec & Plan
    REQ -->|Approval Gate| TASK[to-tasks<br/><i>Vertical Slices + TRACKER</i>]:::build
    TASK --> IMP
    PROTO -->|Keputusan Solid| IMP
    ARCH -->|Kandidat Terpilih| IMP
    SETUP --> MIG[project-migration<br/><i>State di .workspace/migration</i>]:::context
    MIG --> IMP

    %% Pipeline Verifikasi & Delivery
    IMP -->|Diff Ready| REV[code-review<br/><i>Spec + Style + Security</i>]:::review
    BUG -->|Fix Ready| REV
    
    REV -->|REVISE| IMP
    REV -->|PASS Verdict| COMMIT[git-commit<br/><i>Snapshot Reuse + Gitleaks</i>]:::gate
    CONF -->|Resolved| COMMIT
    
    COMMIT --> DONE([Clean Repo State]):::gate
```

**Themes (4)**

- `catppuccin-mocha` — tema Mocha
- `github-dark-default` — tema GitHub Dark default
- `solar-ignis` — tema charcoal monokrom dengan aksen pastel api solar ignis
- `urple` — varian ungu gelap

`dashboard-state` adalah modul internal yang dipakai bersama oleh `git-info`, `ui-customization`, dan `usage-tracker`; bukan extension user-facing terpisah.

Setup aktif juga memakai extension dan skill eksternal dari Orca (`extensions/orca-*.ts` serta skill seperti `computer-use`, `find-skills`, `orca-cli`, dan `orchestration`). Sumber daya eksternal tersebut dikelola oleh host Orca dan sengaja tidak diikutkan ke repo ini. Memory lintas agent dikelola via vault Obsidian bersama melalui skill `agent-memory`.

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

Installer menempatkan resource runtime Pi (`extensions/`, `prompts/`, `themes/`, dan `node_modules/`) ke root agent Pi dan `skills/` ke `~/.agents/skills/`, tanpa metadata Git atau file setup repository. State pribadi tetap dipertahankan. Skill eksternal lain di `~/.agents/skills/` dan package Pi tambahan dikelola terpisah. Untuk direktori lama, gunakan mode repair di [SETUP.md](SETUP.md).

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

Setiap ekstensi di `extensions/` merupakan modul TypeScript mandiri. Lihat `extensions/<name>/` untuk struktur internal masing-masing.

Perintah verifikasi repositori:

- `npm run check`: typecheck seluruh ekstensi (`tsc --noEmit`)
- `npm run check:extensions`: smoke test dan pemeriksaan paket ekstensi
- `npm run test:code-safety`: unit test untuk modul keamanan `code-safety` (`ttsr`, `failure-recovery`, dll.)
- `npm run test:subagents`: test suite untuk `subagents` (Vitest)
- `npm run test:task-judge`: unit test untuk `task-judge` (di dalam `todos/judge`)
- `npm run test:todos`: unit test terintegrasi untuk `todos` (core, lifecycle, dan judge)
- `npm run test:zenith-router`: unit test untuk `zenith-router`
- `npm run test:ui-customization`: unit test untuk `ui-customization`
- `npm run format:check`: verifikasi format kode via Prettier
- `npm run audit:sessions`: audit baca-saja atas log sesi Pi

`subagents` saat ini versi `2.0.0`, memakai Biome dan Vitest. Perintah utama manajemen subagent adalah `/subagents` dengan agen bawaan `@general`, `@build`, dan `@explore`. Extension yang dikelola Orca (`extensions/orca-*.ts`) dihasilkan oleh host Orca secara dinamis dan diabaikan dari repo ini.
