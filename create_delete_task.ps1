# create_delete_task.ps1
# ============================================================
# Registers the daily cleanup (delete_daily_export.py, 18:00) the same
# reliable way as create_scheduled_task.ps1 -- see that file for the full
# explanation of why (survives logouts/reboots, catches up a missed run,
# retries on failure) and what it needs (an elevated PowerShell for the
# strongest guarantee; falls back to a still-improved standard task
# otherwise).
#
# Run this ONCE on the HO server: right-click -> "Run with PowerShell".
# For the "runs even when logged out" guarantee, run it from an elevated
# PowerShell instead (right-click PowerShell -> Run as Administrator).
# ============================================================

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "SalemMallBIDeleteExport"

$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\py.exe" `
  -Argument "-3 `"$scriptDir\delete_daily_export.py`"" `
  -WorkingDirectory $scriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At 6:00PM

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

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
  Write-Host "Falling back to a standard task instead." -ForegroundColor Yellow
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
  Write-Host "Task '$taskName' registered: daily at 18:00, runs even if nobody's logged in." -ForegroundColor Green
} else {
  Write-Host "Task '$taskName' registered: daily at 18:00." -ForegroundColor Green
  Write-Host "NOTE: still requires a user logged in at 18:00 to run -- re-run this script" -ForegroundColor Yellow
  Write-Host "from an elevated PowerShell later to remove that requirement." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Verify: Start-ScheduledTask -TaskName '$taskName'  (then check delete_log.txt)"
