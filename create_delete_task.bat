@echo off
REM ============================================================
REM  create_delete_task.bat
REM  Registers a daily Windows Task that runs delete_daily_export.py at
REM  18:00 — well after upload_daily.py has already pushed the day's file
REM  to Railway at 05:00. Run this ONCE on the HO server by double-clicking
REM  it (or right-click > Run as administrator if it fails).
REM ============================================================

set TASK_NAME=SalemMallBIDeleteExport
set TIME=18:00
set SCRIPT_DIR=%~dp0

schtasks /Create /TN "%TASK_NAME%" ^
  /TR "python \"%SCRIPT_DIR%delete_daily_export.py\"" ^
  /SC DAILY /ST %TIME% /F

echo.
echo Task "%TASK_NAME%" scheduled for %TIME% daily.
echo You can view/edit it any time in Task Scheduler (search "Task Scheduler" in Start menu).
pause
