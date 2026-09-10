# create_scheduled_task.ps1
# ============================================================
# Registers the daily upload as a Windows Scheduled Task, the RELIABLE way.
#
# Why this replaces create_scheduled_task.bat: a task created with plain
# `schtasks /Create` (what the .bat file used) only runs while a user is
# actively logged in. If the HO server reboots overnight -- a Windows
# Update, a power blip -- and nobody logs back in before 05:00, that day's
# run silently never fires. This is the single most likely reason the
# scheduler "works most days but not every day."
#
# This script tries to register the task so it:
#   - Runs whether anyone is logged in or not (-LogonType S4U), with NO
#     password needing to be stored anywhere -- S4U impersonates your
#     account's token without the plaintext password. It's slightly more
#     restricted than a full interactive logon (no access to things needing
#     network credential delegation, like mapped SMB shares) but that
#     doesn't matter here: reading a local folder and making an outbound
#     HTTPS call both work fine under S4U.
#   - Catches a missed run: if the machine was off/asleep at 05:00,
#     -StartWhenAvailable runs it as soon as the machine is next available,
#     rather than silently skipping the day entirely.
#   - Retries automatically at the OS level if the script itself fails
#     (non-zero exit code) -- 3 attempts, 5 minutes apart -- on top of the
#     retry logic already inside upload_daily.py itself for network blips.
#
# The S4U part specifically requires this script to run in an ELEVATED
# PowerShell (right-click PowerShell -> "Run as Administrator", then run
# this .ps1 from there) -- that's a one-time Windows requirement for
# registering a task that can run without anyone logged in, not something
# this script can work around. If you run this NOT elevated, it still
# registers the task (falling back to the same logon behaviour as before)
# with the StartWhenAvailable/retry improvements, and tells you clearly
# what it did and how to get the stronger guarantee.
#
# If running this is blocked by execution policy, run this first in an
# elevated PowerShell: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# ============================================================

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "SalemMallBIUpload"

$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\py.exe" `
  -Argument "-3 `"$scriptDir\upload_daily.py`"" `
  -WorkingDirectory $scriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At 5:00AM

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

# Deliberately NOT -RunLevel Highest: this task only reads a local folder
# and makes an outbound HTTPS call, neither of which needs admin rights, and
# Highest would need elevation for no actual benefit here.
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType S4U

$registeredWithS4U = $true
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
} catch {
  Write-Host ""
  Write-Host "Could not register with 'runs even when logged out' (needs an elevated" -ForegroundColor Yellow
  Write-Host "PowerShell): $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Falling back to a standard task instead (still gets the missed-run" -ForegroundColor Yellow
  Write-Host "catch-up and auto-retry improvements, just not the logout/reboot fix)." -ForegroundColor Yellow
  $registeredWithS4U = $false
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Settings $settings -Force -ErrorAction Stop | Out-Null
  } catch {
    Write-Host ""
    Write-Host "FAILED to register the task at all: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
}

Write-Host ""
if ($registeredWithS4U) {
  Write-Host "Task '$taskName' registered: daily at 05:00, runs even if nobody's logged in," -ForegroundColor Green
  Write-Host "catches up if the machine was off, and retries automatically on failure." -ForegroundColor Green
} else {
  Write-Host "Task '$taskName' registered: daily at 05:00, catches up if the machine was" -ForegroundColor Green
  Write-Host "off, and retries automatically on failure." -ForegroundColor Green
  Write-Host "NOTE: this still requires a user to be logged in at 05:00 to actually run --" -ForegroundColor Yellow
  Write-Host "re-run this script from an elevated ('Run as Administrator') PowerShell" -ForegroundColor Yellow
  Write-Host "later to remove that requirement." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "IMPORTANT -- verify it actually works, don't just trust that registering it worked:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "then wait a few seconds and check upload_log.txt next to this script."
Write-Host ""
Write-Host "To check the task's run history any time:"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$taskName'"
