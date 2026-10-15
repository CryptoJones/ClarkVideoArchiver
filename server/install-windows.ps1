<#
.SYNOPSIS
Installs or removes the Scheduled Task that runs the helper service at logon.

.DESCRIPTION
The Windows equivalent of installing cva-helper.service: registers a per-user
Scheduled Task named ClarkVideoArchiverHelper that starts run-windows.ps1
(and through it cva_helper.py) when you log on, keeps it running indefinitely,
and relaunches it if it dies. No administrator rights are needed: the task
runs as you, only while you are logged on, with no stored password.

Paths are taken from where this script lives, so the repository can be cloned
anywhere. Re-run after moving it. Python, ffmpeg and yt-dlp are found on PATH
when the task starts - see run-windows.ps1 -Check.

.PARAMETER Uninstall
Stop the helper and remove the Scheduled Task.

.PARAMETER NoStart
Register the task but do not start it now (it will still start at next logon).

.PARAMETER TaskName
Name of the Scheduled Task. Default: ClarkVideoArchiverHelper.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File server\install-windows.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File server\install-windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$NoStart,
    [string]$TaskName = 'ClarkVideoArchiverHelper'
)

$ErrorActionPreference = 'Stop'

$serverDir = $PSScriptRoot
$runner = Join-Path $serverDir 'run-windows.ps1'
# Windows PowerShell is on every supported Windows; the runner is written for it.
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

function Stop-Helper {
    # Task Scheduler terminates the task's own process; run-windows.ps1's job
    # object takes the helper down with it. Sweep for a survivor anyway (a
    # helper started before the job object existed, or a failed attach), but
    # only one running this repository's script, never someone's other copy.
    if ($existing -and $existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
    Start-Sleep -Milliseconds 500
    $helperScript = Join-Path $serverDir 'cva_helper.py'
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($helperScript) } |
        ForEach-Object {
            Write-Host "Stopping leftover helper process $($_.ProcessId)."
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

if ($Uninstall) {
    if (-not $existing) {
        Write-Host "Scheduled task '$TaskName' is not installed; nothing to do."
        exit 0
    }
    Stop-Helper
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'. The helper is stopped and will not start at logon."
    exit 0
}

if (-not (Test-Path $runner)) {
    Write-Error "run-windows.ps1 not found next to this script ($runner)."
    exit 1
}

Write-Host 'Checking requirements...'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Check
if ($LASTEXITCODE -ne 0) {
    Write-Error 'A requirement is missing (see above). Install it, open a new terminal so PATH is refreshed, and run this again.'
    exit 1
}

if ($existing) {
    Write-Host "Replacing the existing '$TaskName' task..."
    Stop-Helper
}

# Mirrors the unit: ExecStart -> Action, WantedBy=default.target -> AtLogOn,
# Restart=on-failure -> run-windows.ps1's own loop plus the task-level retry
# below as a backstop should the wrapper itself die.
#
# Launched through a headless conhost: when Windows Terminal is the default
# terminal it ignores -WindowStyle Hidden and leaves a visible window open.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$action = New-ScheduledTaskAction -Execute $conhost `
    -Argument ('--headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $powershell, $runner) `
    -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
# A long-running service must never be killed for "running too long"; the
# cmdlet's default is three days. PT0S is how Task Scheduler spells "no limit".
$settings.ExecutionTimeLimit = 'PT0S'
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'Clark Video Archiver helper service (ffmpeg/yt-dlp backend for the browser extension). Bound to 127.0.0.1:8788.' | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $user (starts at logon, restarts on failure)."

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Started. Waiting for the helper to answer...'
    $healthy = $false
    foreach ($i in 1..15) {
        Start-Sleep -Seconds 1
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8788/api/health' -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
    if ($healthy) {
        Write-Host 'Helper is up: http://127.0.0.1:8788/api/health answered.'
    } else {
        Write-Warning 'No answer on http://127.0.0.1:8788 yet. If you changed the port that is expected; otherwise check the log below.'
    }
}

Write-Host ''
Write-Host 'Verify:'
Write-Host "  Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State"
Write-Host '  Invoke-RestMethod http://127.0.0.1:8788/api/health'
Write-Host '  Get-Content "$env:LOCALAPPDATA\ClarkVideoArchiver\cva-helper.log" -Tail 20'
Write-Host 'Stop / start by hand:'
Write-Host "  Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host 'Remove:'
Write-Host '  powershell -ExecutionPolicy Bypass -File server\install-windows.ps1 -Uninstall'
