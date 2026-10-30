# Setup Pi Personal

## Instal cepat

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.ps1 | iex
```

### macOS/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.sh | bash
```

Script memasang repository langsung ke direktori global Pi:

- macOS/Linux: `~/.pi/agent`
- Windows: `$HOME\.pi\agent`
- Override resmi Pi: `PI_CODING_AGENT_DIR`

Script menjalankan `npm ci` di staging lalu hanya menempatkan resource runtime Pi (`AGENTS.md`, `SOUL.md`, `extensions/`, `prompts/`, `themes/`, dan `node_modules/`) ke agent directory. Folder `skills/` dipasang ke `~/.agents/skills/`, bukan ke agent directory. Metadata Git, README, lockfile, `package.json`, TypeScript config, dan script installer tidak ikut dideploy.

State pribadi seperti `auth.json`, `settings.json`, session, model store, `bin/`, `npm/`, `run-summaries.config.json`, dan konfigurasi `.pi/subagents.*` tidak ditimpa. Pada mode repair, skill lama di `~/.pi/agent/skills/` yang belum ada di `~/.agents/skills/` dipindahkan ke sana. Skill lain di `~/.agents/skills/`, termasuk skill eksternal, tidak diganti; hanya skill yang ada di repo ini yang ditimpa.

## Instal manual

```bash
git clone https://github.com/Divarizky/pi-setup.git ~/.pi/agent
cd ~/.pi/agent
npm ci
```

Restart Pi setelah instalasi.

## Repair instalasi lama

Jika direktori agent sudah ada tetapi bukan repository Git, gunakan mode repair. Mode ini:

1. Membuat backup bertimestamp di `../pi-agent-backups/`.
2. Membackup state Pi dan file lokal seperti `auth.json`, `settings.json`, `run-summaries.config.json`, `.pi/`, `sessions/`, `bin/`, dan `npm/`.
3. Menghapus metadata/file setup lama serta resource runtime yang akan diganti.
4. Meng-clone repository ke staging, lalu menyalin resource runtime Pi ke root agent dan `skills/` ke `~/.agents/skills/`.
5. Menjalankan `npm ci` di staging dan memvalidasi `extensions/`, `prompts/`, `node_modules/`, serta `~/.agents/skills/`. Validasi kompatibilitas runtime tetap perlu dilakukan setelah sinkronisasi.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.ps1 -OutFile $env:TEMP\pi-install.ps1
& $env:TEMP\pi-install.ps1 -Repair
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Divarizky/pi-setup/main/install.sh -o /tmp/pi-install.sh
bash /tmp/pi-install.sh --repair
```

Override lokasi jika diperlukan:

```bash
PI_CODING_AGENT_DIR="$HOME/.pi/agent" bash /tmp/pi-install.sh --repair
```

## Konfigurasi lokal

- Credential provider tetap dikelola Pi melalui `/login` dan `auth.json` lokal.
- Konfigurasi summary model dibuat dari command `/summary-model`; file private tidak masuk repository.
- Konfigurasi subagents global berada di `~/.pi/agent/subagents.json` dan `~/.pi/agent/subagents.yaml`; file `.pi/subagents.*` bersifat project-local.
- Tambahkan konfigurasi Pi pribadi ke `~/.pi/agent/settings.json` setelah instalasi.
- MCP dan package Pi tambahan (`pi-web-access`, `pi-mcp-adapter`) dikelola oleh konfigurasi lokal, bukan oleh root repo.
- Skill eksternal lain di `~/.agents/skills/` dikelola terpisah dan tidak diganti oleh installer.

## Validasi

```bash
npm run check
npm run check:extensions
npm run format:check
npm run test:git-info
npm run test:run-summaries
npm run test:subagents
npm run test:todos
npm run test:task-judge
npm run test:audit-sessions
npm run sync:runtime
```

`extensions/subagents` memakai Biome dan test suite sendiri. Extension yang dikelola Orca (`extensions/orca-*.ts`) dikelola di luar repository.

Tidak semua extension wajib dijalankan pada setiap device; extension yang membutuhkan provider atau Orca dapat menampilkan status unavailable tanpa credential terkait.
