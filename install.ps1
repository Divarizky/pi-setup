[CmdletBinding()]
param(
  [string]$RepoUrl = $(if ($env:PI_SETUP_REPO_URL) { $env:PI_SETUP_REPO_URL } else { "https://github.com/Divarizky/pi-setup.git" }),
  [string]$AgentDir = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } elseif ($env:PI_AGENT_DIR) { $env:PI_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }),
  [switch]$Repair
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git tidak ditemukan. Install Git lalu jalankan ulang script ini."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm tidak ditemukan. Install Node.js LTS lalu jalankan ulang script ini."
}

$AgentDir = [System.IO.Path]::GetFullPath($AgentDir)
$AgentParent = Split-Path -Parent $AgentDir
$BackupRoot = Join-Path $AgentParent "pi-agent-backups"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $BackupRoot $Stamp
$StageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-setup-" + [guid]::NewGuid().ToString("N"))

# Hanya path ini yang dideploy ke direktori agent Pi.
$PiItems = @("AGENTS.md", "extensions", "skills", "prompts", "themes", "APPEND_SYSTEM.md", "SYSTEM.md", "node_modules")
# Metadata repository dan file development/installer tidak dideploy.
$CleanItems = @(
  ".git", ".github", ".gitignore", "README.md", "SETUP.md",
  "install.sh", "install.ps1", "package.json", "package-lock.json", "tsconfig.json"
)
# State Pi dan tools lokal tidak pernah diganti.
$StateItems = @(
  "auth.json", "settings.json", "trust.json", "models.json", "models-store.json", "usage-tracker.json",
  "mcp.json", "mcp-cache.json", "sessions", "bin", "npm"
)

try {
  $AgentExists = Test-Path -LiteralPath $AgentDir
  if ((Test-Path -LiteralPath (Join-Path $AgentDir ".git")) -and -not $Repair) {
    Write-Host "Repository sudah ada: $AgentDir"
    Push-Location $AgentDir
    try { npm ci --ignore-scripts --no-audit --no-fund }
    finally { Pop-Location }
    Write-Host "Pi setup selesai. Restart Pi untuk memuat extension dan skill."
    exit 0
  }

  if ($AgentExists -and -not $Repair) {
    throw "$AgentDir sudah ada tetapi bukan repository Git. Jalankan ulang dengan -Repair untuk backup dan sinkronisasi bersih."
  }

  New-Item -ItemType Directory -Force -Path $AgentParent | Out-Null
  git clone --depth 1 $RepoUrl $StageDir
  Push-Location $StageDir
  try { npm ci --ignore-scripts --no-audit --no-fund }
  finally { Pop-Location }

  if ($Repair -and $AgentExists) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    Write-Host "Membuat backup ke: $BackupDir"
    foreach ($Item in @($CleanItems + $PiItems + $StateItems)) {
      $Source = Join-Path $AgentDir $Item
      if (Test-Path -LiteralPath $Source) {
        $Destination = Join-Path $BackupDir $Item
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
      }
    }
    $CleanItems | Set-Content -LiteralPath (Join-Path $BackupDir "excluded-items.txt")
    $PiItems | Set-Content -LiteralPath (Join-Path $BackupDir "pi-items.txt")
    $StateItems | Set-Content -LiteralPath (Join-Path $BackupDir "state-items.txt")

    foreach ($Item in $CleanItems) {
      $Path = Join-Path $AgentDir $Item
      if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
    }
    foreach ($Item in $PiItems) {
      $StagePath = Join-Path $StageDir $Item
      $Path = Join-Path $AgentDir $Item
      if (Test-Path -LiteralPath $StagePath) {
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
      }
    }
  }

  New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
  foreach ($Item in $PiItems) {
    $Source = Join-Path $StageDir $Item
    if (Test-Path -LiteralPath $Source) {
      $Destination = Join-Path $AgentDir $Item
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
      Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
    }
  }

  # Merge skill lokal yang tidak ada di repository (mis. skill pribadi/shared).
  $BackupSkills = Join-Path $BackupDir "skills"
  $TargetSkills = Join-Path $AgentDir "skills"
  if ($Repair -and (Test-Path -LiteralPath $BackupSkills) -and (Test-Path -LiteralPath $TargetSkills)) {
    Get-ChildItem -LiteralPath $BackupSkills -Force | ForEach-Object {
      $Destination = Join-Path $TargetSkills $_.Name
      if (-not (Test-Path -LiteralPath $Destination)) {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
      }
    }
  }

  foreach ($Item in @("extensions", "skills", "prompts", "node_modules")) {
    if (-not (Test-Path -LiteralPath (Join-Path $AgentDir $Item))) {
      throw "Instalasi tidak lengkap: $Item tidak ditemukan."
    }
  }

  if ($Repair) {
    Write-Host "Repair selesai. State pribadi tetap berada di $AgentDir."
    Write-Host "Backup tersedia di: $BackupDir"
  } else {
    Write-Host "Pi setup selesai."
  }
  Write-Host "Restart Pi untuk memuat extension dan skill."
}
finally {
  if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force }
}
