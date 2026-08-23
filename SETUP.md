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

Script memasang repository ke `~/.pi/agent`, menjalankan `npm ci`, dan tidak menyalin state pribadi seperti `auth.json`, `settings.json`, session, atau model store.

## Instal manual

```bash
git clone https://github.com/Divarizky/pi-setup.git ~/.pi/agent
cd ~/.pi/agent
npm ci
```

Restart Pi setelah instalasi.

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
