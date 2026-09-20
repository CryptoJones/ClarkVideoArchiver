<#
.SYNOPSIS
Runs the Clark Video Archiver helper service on Windows and keeps it running.

.DESCRIPTION
The Windows counterpart of cva-helper.service. It finds a Python 3.9+
interpreter, starts cva_helper.py from the folder this script lives in, writes
the helper's output to a log file, and restarts it three seconds after any
failure - the same Restart=on-failure / RestartSec=3 the systemd unit gives
Linux users. A clean exit (Ctrl-C, exit code 0) is not restarted, and five
failures in quick succession (a port already in use, say) make it give up,
like systemd's start limit; the Scheduled Task then retries a minute later.

The helper and anything it spawns (ffmpeg, yt-dlp) are placed in a Windows job
object that is torn down with this script, so stopping the Scheduled Task, or
closing the terminal, never leaves a stray helper holding the port.

Run it by hand from a terminal to watch the helper work, or let the Scheduled
Task that install-windows.ps1 registers run it at logon. Configuration that the
unit file keeps in Environment= lines lives in the block marked below.

Log: %LOCALAPPDATA%\ClarkVideoArchiver\cva-helper.log (override with
CVA_HELPER_LOG). Rotated once to cva-helper.1.log when it passes 5 MB.

.PARAMETER Check
Report which Python, ffmpeg and yt-dlp would be used and exit. Exit code is 0
when the helper could start, 1 when a requirement is missing.

.PARAMETER HelperArgs
Everything else on the command line is passed through to cva_helper.py,
e.g. --port 9000 --token s3cret. The Scheduled Task passes nothing; put
permanent arguments in the configuration block instead.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File server\run-windows.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File server\run-windows.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$HelperArgs = @()
)

# Native stderr must flow as text, not terminate the script.
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Configuration - the equivalent of the Environment= lines in cva-helper.service.
# Values already set in your user environment win; nothing here overwrites one.
# ---------------------------------------------------------------------------

# Arguments cva_helper.py always gets, e.g. @('--port', '9000', '--token', 's3cret').
$PermanentArgs = @()

# YouTube needs a JavaScript runtime to solve its signature challenge. node is
# used automatically when it is on PATH; deno or bun work too.
if (-not $env:CVA_YTDLP_JS_RUNTIME -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $env:CVA_YTDLP_JS_RUNTIME = 'node'
}

# YouTube usually also needs your browser's cookies to avoid an HTTP 403. Name
# the browser you are signed in with (firefox, chrome, edge, brave, ...). Off by
# default: naming a browser that is not installed makes every yt-dlp job fail.
# if (-not $env:CVA_YTDLP_COOKIES_FROM_BROWSER) { $env:CVA_YTDLP_COOKIES_FROM_BROWSER = 'firefox' }

# How many failures within RapidWindow seconds of starting count as "hopeless".
$RapidLimit = 5
$RapidWindow = 10
$RestartDelay = 3

# ---------------------------------------------------------------------------

$serverDir = $PSScriptRoot
$helperScript = Join-Path $serverDir 'cva_helper.py'

function Find-Python {
    <#
    First Python 3.9+ found, as @{ Exe; Prefix } where Prefix is the extra
    argument some launchers need (py.exe -3). Candidates are probed by running
    them, which also makes the Microsoft Store's "python.exe" placeholder safe
    to hit: given arguments it prints a hint and exits non-zero rather than
    opening the Store. CVA_PYTHON pins a specific interpreter.

    A launcher is then resolved to the interpreter it would start, so the
    helper is this script's direct child rather than a grandchild.
    #>
    $candidates = @()
    if ($env:CVA_PYTHON) { $candidates += , @{ Exe = $env:CVA_PYTHON; Prefix = @() } }
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) { $candidates += , @{ Exe = $py.Source; Prefix = @('-3') } }
    foreach ($name in 'python.exe', 'python3.exe') {
        foreach ($cmd in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
            $candidates += , @{ Exe = $cmd.Source; Prefix = @() }
        }
    }
    # No quotes inside the probes: Windows PowerShell 5.1 does not escape them for native commands.
    $probe = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'
    $which = 'import sys; print(sys.executable)'
    foreach ($c in $candidates) {
        try {
            & $c.Exe @($c.Prefix + @('-c', $probe)) 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { continue }
            # Collect all output rather than Select-Object -First 1: cutting a
            # native command's pipeline short discards its real exit code.
            $real = @(& $c.Exe @($c.Prefix + @('-c', $which)) 2>$null)
            $real = if ($real.Count) { "$($real[0])".Trim() } else { '' }
            if ($LASTEXITCODE -eq 0 -and $real -and (Test-Path -LiteralPath $real)) {
                return @{ Exe = $real; Prefix = @() }
            }
            return $c
        } catch { }
    }
    return $null
}

function Get-PythonVersion($python) {
    try {
        $out = @(& $python.Exe @($python.Prefix + @('-c', 'import platform; print(platform.python_version())')) 2>$null)
        if ($out.Count) { return "$($out[0])".Trim() }
    } catch { }
    return '?'
}

$python = Find-Python
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ytdlp = Get-Command yt-dlp -ErrorAction SilentlyContinue

$logDir = Join-Path $env:LOCALAPPDATA 'ClarkVideoArchiver'
$logPath = if ($env:CVA_HELPER_LOG) { $env:CVA_HELPER_LOG } else { Join-Path $logDir 'cva-helper.log' }

if ($Check) {
    $pyText = if ($python) { "$($python.Exe) $($python.Prefix -join ' ') ($(Get-PythonVersion $python))" -replace '\s+', ' ' } else { 'NOT FOUND - install Python 3.9+ from python.org or the Microsoft Store' }
    $ffText = if ($ffmpeg) { $ffmpeg.Source } else { 'NOT FOUND - required (winget install Gyan.FFmpeg, then open a new terminal)' }
    $ytText = if ($ytdlp) { $ytdlp.Source } else { 'not found (page URLs unavailable; winget install yt-dlp.yt-dlp)' }
    Write-Host "python   $pyText"
    Write-Host "ffmpeg   $ffText"
    Write-Host "yt-dlp   $ytText"
    Write-Host "script   $helperScript"
    Write-Host "log      $logPath"
    if ($python -and $ffmpeg -and (Test-Path $helperScript)) { exit 0 } else { exit 1 }
}

if (-not $python) {
    Write-Error 'No Python 3.9+ interpreter found. Install it from python.org or the Microsoft Store, or set CVA_PYTHON to one.'
    exit 1
}
if (-not (Test-Path $helperScript)) {
    Write-Error "cva_helper.py not found next to this script ($helperScript)."
    exit 1
}

# -- logging ---------------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Split-Path $logPath -Parent) | Out-Null
if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 5MB) {
    Move-Item -Force -LiteralPath $logPath -Destination (($logPath -replace '\.log$', '') + '.1.log')
}
# Shared append: a second instance (a manual run while the task is up) must
# fail at the port with a readable message, not here with a locked file.
$logStream = New-Object System.IO.FileStream($logPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
$log = New-Object System.IO.StreamWriter($logStream, (New-Object System.Text.UTF8Encoding($false)))
$log.AutoFlush = $true

function Write-Log([string]$line) {
    $stamped = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $line
    $log.WriteLine($stamped)
    Write-Host $stamped
}

# -- job object ------------------------------------------------------------
# Everything assigned to the job is killed when the last handle to it closes,
# and the only handle is this process's. Task Scheduler ends a task by
# terminating its process outright, with no chance to run cleanup code; the
# job object is what makes that still take the helper (and any ffmpeg or
# yt-dlp it is running) down with it.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CvaJob
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    static IntPtr job = IntPtr.Zero;   // deliberately never closed: closing it is the kill switch

    public static string Add(int pid)
    {
        if (job == IntPtr.Zero)
        {
            IntPtr h = CreateJobObject(IntPtr.Zero, null);
            if (h == IntPtr.Zero) return "CreateJobObject failed: " + Marshal.GetLastWin32Error();
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr p = Marshal.AllocHGlobal(len);
            try
            {
                Marshal.StructureToPtr(info, p, false);
                if (!SetInformationJobObject(h, JobObjectExtendedLimitInformation, p, (uint)len))
                    return "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
            }
            finally { Marshal.FreeHGlobal(p); }
            job = h;
        }
        using (var proc = System.Diagnostics.Process.GetProcessById(pid))
        {
            if (!AssignProcessToJobObject(job, proc.Handle))
                return "AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error();
        }
        return null;
    }
}
'@

function Get-HelperChildren {
    # The helper this script started: direct children (and their children,
    # for a launcher that forwards to the real interpreter) whose command
    # line names cva_helper.py.
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $found = @()
    $kids = @($all | Where-Object { $_.ParentProcessId -eq $PID })
    $grandkids = @($all | Where-Object { $p = $_.ParentProcessId; $kids | Where-Object { $_.ProcessId -eq $p } })
    foreach ($proc in ($kids + $grandkids)) {
        if ($proc.CommandLine -and $proc.CommandLine.Contains($helperScript)) { $found += $proc.ProcessId }
    }
    return $found
}

# The helper prints UTF-8 (PYTHONIOENCODING); decode it as such on the way in.
$savedEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$exitCode = 0
try {
    $argList = @($python.Prefix) + @('-u', $helperScript) + @($PermanentArgs) + @($HelperArgs)
    $rapidFailures = 0
    while ($true) {
        Write-Log "starting: $($python.Exe) $($argList -join ' ')"
        $started = Get-Date
        $adopted = $false
        # 2>&1 turns stderr lines into ErrorRecords; "$_" is the text either way.
        # The helper prints its banner before it can accept work, so adopting
        # it into the job on the first line is early enough.
        & $python.Exe @argList 2>&1 | ForEach-Object {
            if (-not $adopted) {
                $adopted = $true
                foreach ($childPid in Get-HelperChildren) {
                    $err = [CvaJob]::Add($childPid)
                    if ($err) { Write-Log "warning: could not attach pid $childPid to the job object ($err); stopping the task may leave it running" }
                }
            }
            Write-Log "$_"
        }
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            Write-Log 'helper stopped cleanly'
            break
        }
        $uptime = ((Get-Date) - $started).TotalSeconds
        if ($uptime -lt $RapidWindow) { $rapidFailures++ } else { $rapidFailures = 0 }
        if ($rapidFailures -ge $RapidLimit) {
            Write-Log "helper exited with code $code; $RapidLimit failures within $RapidWindow s each - giving up (Task Scheduler retries in a minute)"
            $exitCode = 1
            break
        }
        Write-Log "helper exited with code $code; restarting in $RestartDelay s"
        Start-Sleep -Seconds $RestartDelay
    }
} finally {
    foreach ($childPid in Get-HelperChildren) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
    [Console]::OutputEncoding = $savedEncoding
    $log.Dispose()
}
exit $exitCode
