@echo off
REM ============================================================
REM  create_scheduled_task.bat
REM
REM  PREFER create_scheduled_task.ps1 INSTEAD OF THIS FILE if you can --
REM  it registers a task that keeps running even if the HO server reboots
REM  or nobody's logged in, and retries automatically on failure. A task
REM  from THIS .bat file only runs while a user is actively logged into
REM  the server -- if it reboots overnight and nobody logs back in before
REM  05:00, that day's run is silently skipped. That's the single most
REM  likely reason a "sometimes works, sometimes doesn't" scheduler was
REM  reported. Kept here only as a fallback for machines where running a
REM  .ps1 isn't practical.
REM
REM  Registers a daily Windows Task that runs upload_daily.py.
REM  Run this ONCE on the HO server by double-clicking it (or right-click >
REM  Run as administrator if it fails). Edit the TIME value below first —
REM  set it a few minutes AFTER the iTrade export job finishes for the day.
REM ============================================================

set TASK_NAME=SalemMallBIUpload
set TIME=05:00
set SCRIPT_DIR=%~dp0

REM Uses the "py" launcher via its full path (%SystemRoot%\py.exe), NOT the
REM bare "python" command. Task Scheduler resolves the task's Program via
REM PATH in ITS OWN process environment, which is often stale/different from
REM an interactive Command Prompt's PATH -- "python" can work fine when you
REM run it or double-click the script yourself, yet fail silently (with
REM nothing printed anywhere) when Task Scheduler tries to launch it. The py
REM launcher is installed into the Windows folder itself by the official
REM installer, which is always on every process's PATH, sidestepping that.
schtasks /Create /TN "%TASK_NAME%" ^
  /TR "\"%SystemRoot%\py.exe\" -3 \"%SCRIPT_DIR%upload_daily.py\"" ^
  /SC DAILY /ST %TIME% /F

echo.
echo Task "%TASK_NAME%" scheduled for %TIME% daily.
echo You can view/edit it any time in Task Scheduler (search "Task Scheduler" in Start menu).
echo.
echo IMPORTANT: right-click the task in Task Scheduler -^> Run, once, to confirm
echo it actually succeeds end-to-end -- then check upload_log.txt next to this
echo script for the result.
pause
