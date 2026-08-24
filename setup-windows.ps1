# Sets up the screen-share companion on Windows.
#
#   Right-click -> Run with PowerShell,  or:
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1
#
# Installs Node, OBS and rclone, drops the companion into C:\ClosersRecorder,
# and registers it to start automatically when you log in.

$ErrorActionPreference = 'Stop'
$InstallDir = 'C:\ClosersRecorder'
$VideoDir   = 'C:\ClosersRecorder\videos'

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

Say 'Installing Node, OBS Studio and rclone'
foreach ($pkg in @('OpenJS.NodeJS.LTS', 'OBSProject.OBSStudio', 'Rclone.Rclone')) {
  winget install --id $pkg --silent --accept-package-agreements --accept-source-agreements 2>$null | Out-Null
}

# winget doesn't refresh PATH for the running shell
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

Say "Setting up $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir, $VideoDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'companion.js') -Destination $InstallDir -Force

@'
{
  "name": "closers-video-companion",
  "private": true,
  "type": "module",
  "dependencies": { "obs-websocket-js": "^5.0.6" }
}
'@ | Set-Content -Path (Join-Path $InstallDir 'package.json') -Encoding utf8

Say 'Installing the one dependency it needs'
Push-Location $InstallDir
npm install --omit=dev --no-audit --no-fund | Out-Null
Pop-Location

$envFile = Join-Path $InstallDir 'companion.env'
if (-not (Test-Path $envFile)) {
  Say 'Writing companion.env - you still need to fill in three values'
@'
# The bot's public URL on Railway, with /status on the end.
# Railway -> your service -> Settings -> Networking -> Generate Domain
BOT_STATUS_URL=https://REPLACE-ME.up.railway.app/status

# Must match COMPANION_SECRET in the bot's Railway variables, exactly.
COMPANION_SECRET=REPLACE-ME

# OBS -> Tools -> WebSocket Server Settings -> Show Connect Info
OBS_PASSWORD=REPLACE-ME

OBS_URL=ws://127.0.0.1:4455
POLL_SECONDS=4

# Where finished videos go. Leave RCLONE_REMOTE blank to keep them on this PC.
RCLONE_REMOTE=gdrive:Discord Recordings
DELETE_AFTER_UPLOAD=false
'@ | Set-Content -Path $envFile -Encoding utf8
}

Say 'Registering it to start when you log in'
$node = (Get-Command node).Source
$action  = New-ScheduledTaskAction -Execute $node `
             -Argument '--env-file=companion.env companion.js' -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'ClosersVideoCompanion' -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

Write-Host ''
Write-Host '────────────────────────────────────────────────────────────' -ForegroundColor Green
Write-Host ' Installed. Three things left:' -ForegroundColor Green
Write-Host ''
Write-Host "  1. Open OBS once. Tools -> WebSocket Server Settings ->"
Write-Host "     tick Enable, then Show Connect Info to get the password."
Write-Host "     Add a scene with a Display Capture source, and check that"
Write-Host "     Desktop Audio is present in the audio mixer."
Write-Host "     Settings -> Output -> Recording Path: $VideoDir"
Write-Host "     Settings -> Output -> Recording Format: mp4"
Write-Host ''
Write-Host "  2. Fill in the three REPLACE-ME values:"
Write-Host "       notepad $envFile"
Write-Host ''
Write-Host "  3. Authorise Google Drive for uploads:"
Write-Host "       rclone config      (name the remote 'gdrive')"
Write-Host ''
Write-Host "  Then start it now without rebooting:"
Write-Host "       Start-ScheduledTask -TaskName ClosersVideoCompanion"
Write-Host ''
Write-Host "  To watch what it's doing, run it in a window instead:"
Write-Host "       cd $InstallDir; node --env-file=companion.env companion.js"
Write-Host '────────────────────────────────────────────────────────────' -ForegroundColor Green
