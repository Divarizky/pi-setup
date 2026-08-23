[CmdletBinding()]
param(
  [string]$RepoUrl = "https://github.com/Divarizky/pi-setup.git",
  [string]$AgentDir = (Join-Path $HOME ".pi\agent")
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git tidak ditemukan. Install Git lalu jalankan ulang script ini."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm tidak ditemukan. Install Node.js LTS lalu jalankan ulang script ini."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AgentDir) | Out-Null
if (Test-Path (Join-Path $AgentDir ".git")) {
  Write-Host "Repository sudah ada: $AgentDir"
} elseif (Test-Path $AgentDir) {
  throw "$AgentDir sudah ada tetapi bukan repository Git. Pindahkan atau backup folder tersebut terlebih dahulu."
} else {
  git clone $RepoUrl $AgentDir
}

Push-Location $AgentDir
try {
  npm ci
  Write-Host "Pi setup selesai. Restart Pi untuk memuat extension dan skill."
} finally {
  Pop-Location
}
