# Prints (never runs) the Register-ScheduledTask command that starts the login helper
# at logon of the current user. This loop never registers a scheduled task itself --
# that needs an elevated or at least interactive Task Scheduler prompt this loop does
# not have. Aaron runs the printed command himself.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$distEntry = Join-Path $repoRoot 'dist\forge\login-helper.js'
$user = "$env:USERDOMAIN\$env:USERNAME"

Write-Host ""
Write-Host "=== Run this yourself, in a PowerShell prompt as $user ==="
Write-Host "(no elevation needed -- a logon task for the current user does not require it)"
Write-Host ''
Write-Host ("Register-ScheduledTask -TaskName 'FlightdeckLoginHelper' " `
  + "-Trigger (New-ScheduledTaskTrigger -AtLogOn -User '$user') " `
  + "-Action (New-ScheduledTaskAction -Execute 'node.exe' -Argument '""$distEntry""') " `
  + "-Settings (New-ScheduledTaskSettingsSet -Hidden -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)) " `
  + "-User '$user' -RunLevel Limited")
Write-Host ''
Write-Host '=== To undo ==='
Write-Host "Unregister-ScheduledTask -TaskName 'FlightdeckLoginHelper' -Confirm:`$false"
