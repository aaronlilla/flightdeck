# Generates the service-install script from the console's live paths and
# console.env.cmd (never hand-typed), then runs its unelevated half (download,
# verify SHA-256, extract nssm.exe) and prints the elevated block for Aaron to run
# himself in an elevated PowerShell. See src/forge/service/install-script.ts.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  $generated = & npx tsx src/forge/service/run-install-script.ts
  $tempScript = Join-Path $env:TEMP 'forge-service-install-generated.ps1'
  $generated | Out-File -Encoding utf8 $tempScript
  & $tempScript
} finally {
  Pop-Location
}
