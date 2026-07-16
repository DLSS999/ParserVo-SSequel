param(
  [int]$EveryHours = 6,
  [string]$TaskName = "ParserVo Full Catalog Sync"
)

$ErrorActionPreference = "Stop"
if ($EveryHours -lt 1 -or $EveryHours -gt 23) {
  throw "EveryHours must be between 1 and 23."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-local-catalog.ps1"

if (-not (Test-Path (Join-Path $repoRoot ".env.worker"))) {
  throw "Create $repoRoot\.env.worker first. Copy it from .env.worker.example and fill the secret values."
}

$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Category all -MaxProducts 0"

& schtasks.exe /Create /F /SC HOURLY /MO $EveryHours /TN $TaskName /TR $command
if ($LASTEXITCODE -ne 0) {
  throw "schtasks failed with code $LASTEXITCODE. Open PowerShell as Administrator and run again."
}

Write-Host "Scheduled task created: $TaskName"
Write-Host "Interval: every $EveryHours hours"
Write-Host "Command: $command"
Write-Host "Start now with: schtasks.exe /Run /TN `"$TaskName`""
