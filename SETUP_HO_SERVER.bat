@echo off
REM ============================================================
REM  SETUP_HO_SERVER.bat
REM  Double-click this ONCE on the HO server. It asks for admin rights,
REM  then sets up the fully automatic daily upload (see setup_ho_server.ps1).
REM  Safe to run again any time (e.g. after moving this folder).
REM ============================================================

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_ho_server.ps1"
echo.
pause
