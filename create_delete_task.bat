@echo off
REM ============================================================
REM  create_delete_task.bat
REM
REM  PREFER create_delete_task.ps1 INSTEAD OF THIS FILE if you can -- see
REM  the note at the top of create_scheduled_task.bat for why. Kept here
REM  only as a fallback.
REM
REM  Registers a daily Windows Task that runs delete_daily_export.py at
REM  18:00 — well after upload_daily.py has already pushed the day's file
REM  to Railway at 05:00. Run this ONCE on the HO server by double-clicking
REM  it (or right-click > Run as administrator if it fails).
REM ============================================================

set TASK_NAME=SalemMallBIDeleteExport
set TIME=18:00
set SCRIPT_DIR=%~dp0

REM See create_scheduled_task.bat for why this uses the full path to the "py"
REM launcher instead of bare "python" -- Task Scheduler's own PATH lookup is
REM what silently fails otherwise, even when running the script yourself works.
schtasks /Create /TN "%TASK_NAME%" ^
  /TR "\"%SystemRoot%\py.exe\" -3 \"%SCRIPT_DIR%delete_daily_export.py\"" ^
  /SC DAILY /ST %TIME% /F

echo.
echo Task "%TASK_NAME%" scheduled for %TIME% daily.
echo You can view/edit it any time in Task Scheduler (search "Task Scheduler" in Start menu).
pause
