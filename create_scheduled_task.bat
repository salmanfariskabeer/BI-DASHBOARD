@echo off
REM ============================================================
REM  create_scheduled_task.bat
REM  Registers a daily Windows Task that runs upload_daily.py.
REM  Run this ONCE on the HO server by double-clicking it (or right-click >
REM  Run as administrator if it fails). Edit the TIME value below first —
REM  set it a few minutes AFTER the iTrade export job finishes for the day.
REM ============================================================

set TASK_NAME=SalemMallBIUpload
set TIME=05:00
set SCRIPT_DIR=%~dp0

schtasks /Create /TN "%TASK_NAME%" ^
  /TR "python \"%SCRIPT_DIR%upload_daily.py\"" ^
  /SC DAILY /ST %TIME% /F

echo.
echo Task "%TASK_NAME%" scheduled for %TIME% daily.
echo You can view/edit it any time in Task Scheduler (search "Task Scheduler" in Start menu).
pause
