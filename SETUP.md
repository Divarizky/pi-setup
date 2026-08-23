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

Script menjalankan `npm ci` di staging lalu hanya menempatkan resource runtime Pi (`AGENTS.md`, `extensions/`, `skills/`, `prompts/`, dan `node_modules/`) ke agent directory. Metadata Git, README, lockfile, `package.json`, TypeScript config, dan script installer tidak ikut dideploy.

State pribadi seperti `auth.json`, `settings.json`, session, model store, `bin/`, dan `npm/` tidak ditimpa.

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
2. Membackup state Pi dan file lokal seperti `auth.json`, `settings.json`, `sessions/`, `bin/`, dan `npm/`.
3. Menghapus metadata/file setup lama serta resource runtime yang akan diganti.
4. Meng-clone repository ke staging, lalu hanya menyalin resource runtime Pi ke root agent.
5. Menjalankan `npm ci` di staging dan memvalidasi `extensions/`, `skills/`, `prompts/`, serta `node_modules/`.

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
- Tambahkan konfigurasi Pi pribadi ke `~/.pi/agent/settings.json` setelah instalasi.

## Validasi

```bash
npm run check
npm run test:git-info
npm run test:run-summaries
npm run test:subagents
npm run test:todos
```

Tidak semua extension wajib dijalankan pada setiap device; extension yang membutuhkan provider atau Orca dapat menampilkan status unavailable tanpa credential terkait.
