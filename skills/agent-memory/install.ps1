# Install agent-memory di perangkat baru (Windows, PowerShell).
# Syarat: Python (python atau py launcher). Vault terdeteksi otomatis dari
# G:/My Drive, atau set AGENT_MEMORY_VAULT="..." sebagai user env var.
$ErrorActionPreference = "Stop"
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Skills = "$env:USERPROFILE\.agents\skills"

New-Item -ItemType Directory -Force -Path $Skills, "$env:USERPROFILE\.local\bin" | Out-Null
$MemDir = "$env:USERPROFILE\.local\bin"
# Launcher dengan path absolut: memory.bat di source memakai path relatif yang
# rusak bila .bat-nya disalin keluar dari folder skill.
$Py = Join-Path $Src "memory.py"
@"
@echo off
where python >nul 2>nul && (python "$Py" %*) || (py -3 "$Py" %*)
"@ | Set-Content "$MemDir\memory.bat" -Encoding ascii
# Tambah folder bin ke user PATH bila belum ada.
$Path = [Environment]::GetEnvironmentVariable("Path", "User")
if ($Path -notlike "*$MemDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$Path;$MemDir", "User")
  Write-Output "Ditambah ke user PATH (buka terminal baru agar berlaku): $MemDir"
}

function Link-Skill($Target) {
  if (Test-Path $Target) {
    $Link = Join-Path $Target "agent-memory"
    if ([IO.Path]::GetFullPath($Src).TrimEnd('\') -eq [IO.Path]::GetFullPath($Link).TrimEnd('\')) {
      Write-Output "OK $Link (sudah source)"; return
    }
    if (-not (Test-Path $Link)) {
      # Symlink butuh Developer Mode; gagal -> fallback copy.
      try { New-Item -ItemType SymbolicLink -Path $Link -Target $Src | Out-Null; Write-Output "OK $Link" }
      catch { Copy-Item $Src $Link -Recurse -Force; Write-Output "OK $Link (copy, bukan symlink)" }
    } else { Write-Output "OK $Link (sudah ada)" }
  }
}
Link-Skill "$env:USERPROFILE\.agents\skills"
Link-Skill "$env:USERPROFILE\.claude\skills"
Link-Skill "$env:USERPROFILE\.codex\skills"

# Hook SessionStart (read-only brief), merge tanpa menghapus yang ada.
$Entry = @{ type = "command"; command = "memory brief --max-tokens 300"; timeout = 15 }
function Merge-Hooks($File) {
  $d = if (Test-Path $File) { Get-Content $File -Raw | ConvertFrom-Json } else { [pscustomobject]@{ hooks = @{} } }
  if (-not $d.hooks) { $d | Add-Member hooks @{} }
  $lst = @($d.hooks.SessionStart | Where-Object { ($_ | ConvertTo-Json) -notmatch "memory brief" })
  $lst += @{ hooks = @($Entry) }
  $d.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue $lst -Force
  $d | ConvertTo-Json -Depth 6 | Set-Content $File -Encoding utf8
  Write-Output "OK $File"
}
Merge-Hooks "$env:USERPROFILE\.claude\settings.json"
Merge-Hooks "$env:USERPROFILE\.codex\hooks.json"

# Extension Pi (brief otomatis): salin bila folder extensions Pi ada di device ini.
$PiExt = "$env:USERPROFILE\.pi\agent\extensions"
if (Test-Path $PiExt) {
  Copy-Item "$Src\pi-extension\agent-memory.ts" $PiExt -Force
  Write-Output "OK extension Pi"
}

Write-Output "---"
try { & "$MemDir\memory.bat" status } catch {
  Write-Output "Vault tidak ketemu. Set user env AGENT_MEMORY_VAULT=<path vault>."
}
Write-Output "Untuk Pi, restart agar extension agent-memory.ts dimuat."
