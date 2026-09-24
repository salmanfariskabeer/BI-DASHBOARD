# ============================================================
# setup_ho_server.ps1  -- run via SETUP_HO_SERVER.bat (double-click it)
#
# One-time setup on the HO server. Safe to re-run at any time.
#   1. Finds the real python.exe (full path, so Task Scheduler never
#      depends on PATH -- the reason the old "python" task never fired)
#   2. Installs the two packages upload_daily.py needs
#   3. Removes the old tasks and registers:
#        SalemMallBIUpload        05:00, then every hour until 23:00
#        SalemMallBIDeleteExport  23:30 (only deletes files already uploaded)
#      both running whether or not anyone is logged in, and catching up
#      if the server was off at the scheduled time
#   4. Runs the upload task once as a real test and shows the result
# ============================================================

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($msg, $color = "White") { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Say ""; Say "SETUP FAILED: $msg" Red; Say ""; exit 1 }

# ---------- 0. must be elevated ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail "not running as Administrator. Right-click SETUP_HO_SERVER.bat -> Run as administrator." }

foreach ($f in @("upload_daily.py", "delete_daily_export.py", "upload_config.py")) {
  if (-not (Test-Path (Join-Path $scriptDir $f))) { Fail "$f is missing from $scriptDir" }
}

# ---------- 1. find python.exe ----------
Say "[1/4] Finding Python..." Cyan
$candidates = @()
foreach ($cmd in @("py", "python", "python3")) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($c) { $candidates += $c.Source }
}
$candidates += "$env:SystemRoot\py.exe"
$candidates += Get-ChildItem -Path "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", `
  "$env:ProgramFiles\Python3*\python.exe", "C:\Python3*\python.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | ForEach-Object { $_.FullName }

$python = $null
foreach ($c in $candidates | Select-Object -Unique) {
  if (-not (Test-Path $c)) { continue }
  if ($c -like "*WindowsApps*") { continue }   # Microsoft Store stub, not a real Python
  try {
    $args3 = @(); if ((Split-Path $c -Leaf) -eq "py.exe") { $args3 = @("-3") }
    $exe = & $c @args3 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { $python = $exe.Trim(); break }
  } catch {}
}
if (-not $python) { Fail "Python 3 not found. Install it from https://www.python.org/downloads/ (tick 'Add Python to PATH'), then re-run." }
$ver = & $python --version
Say "      Using $python ($ver)" Green

# ---------- 2. packages ----------
Say "[2/4] Installing required packages (requests, requests-toolbelt)..." Cyan
& $python -m pip install --quiet --disable-pip-version-check requests requests-toolbelt
if ($LASTEXITCODE -ne 0) { Fail "pip install failed (is the server online?)" }
& $python -c "import requests, requests_toolbelt" 2>$null
if ($LASTEXITCODE -ne 0) { Fail "packages installed but cannot be imported by $python" }
Say "      OK" Green

# ---------- 3. scheduled tasks ----------
Say "[3/4] Registering scheduled tasks..." Cyan
foreach ($old in @("SalemMallBIUpload", "SalemMallBIDeleteExport")) {
  schtasks /Delete /TN $old /F 2>$null | Out-Null
}

# Use pythonw.exe (no console window) when it exists next to python.exe.
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
$runner = if (Test-Path $pythonw) { $pythonw } else { $python }

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
# S4U = runs whether or not the user is logged on, no password stored.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -WakeToRun

# Upload: 05:00 daily, repeating hourly for 18h (last try ~23:00).
$upTrigger = New-ScheduledTaskTrigger -Daily -At 5:00AM
$upTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At 5:00AM `
  -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 18)).Repetition
$upAction = New-ScheduledTaskAction -Execute $runner -Argument "`"$scriptDir\upload_daily.py`"" -WorkingDirectory $scriptDir

$delTrigger = New-ScheduledTaskTrigger -Daily -At 11:30PM
$delAction = New-ScheduledTaskAction -Execute $runner -Argument "`"$scriptDir\delete_daily_export.py`"" -WorkingDirectory $scriptDir

try {
  Register-ScheduledTask -TaskName "SalemMallBIUpload" -Action $upAction -Trigger $upTrigger `
    -Settings $settings -Principal $principal -Description "Pushes the daily iTrade sales export to the BI dashboard" -Force -ErrorAction Stop | Out-Null
  Register-ScheduledTask -TaskName "SalemMallBIDeleteExport" -Action $delAction -Trigger $delTrigger `
    -Settings $settings -Principal $principal -Description "Deletes iTrade exports already uploaded to the BI dashboard" -Force -ErrorAction Stop | Out-Null
} catch { Fail "could not register tasks: $($_.Exception.Message)" }
Say "      SalemMallBIUpload        05:00, retries hourly until 23:00, runs even when logged out" Green
Say "      SalemMallBIDeleteExport  23:30, only deletes files already uploaded" Green

# ---------- 4. live test through Task Scheduler itself ----------
Say "[4/4] Test-running the upload task through Task Scheduler (can take ~3 min)..." Cyan
$logPath = Join-Path $scriptDir "upload_log.txt"
$logBefore = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }
Start-ScheduledTask -TaskName "SalemMallBIUpload"
Start-Sleep -Seconds 5
$deadline = (Get-Date).AddMinutes(20)
while ((Get-ScheduledTask -TaskName "SalemMallBIUpload").State -eq "Running" -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10; Write-Host "." -NoNewline
}
Write-Host ""
$info = Get-ScheduledTaskInfo -TaskName "SalemMallBIUpload"
if (Test-Path $logPath) {
  $fs = [IO.File]::Open($logPath, "Open", "Read", "ReadWrite")
  $fs.Seek($logBefore, "Begin") | Out-Null
  $new = (New-Object IO.StreamReader($fs)).ReadToEnd(); $fs.Close()
  if ($new.Trim()) { Say ""; Say "--- new log lines ---"; Say $new.Trim() }
}
Say ""
if ($info.LastTaskResult -eq 0) {
  Say "SUCCESS. The task ran under Task Scheduler with exit code 0." Green
  Say "(If no new log lines appeared, today's file was already uploaded -- nothing to do.)" Green
  Say "From now on nobody needs to open upload_daily.py by hand." Green
} else {
  Say ("Task finished with result code 0x{0:X} -- see upload_log.txt above for the reason." -f $info.LastTaskResult) Yellow
}
Say ""
Say "Next scheduled run: $($info.NextRunTime)"
