@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODEEXE=node"

where node >nul 2>nul
if not errorlevel 1 goto RUN

rem Node may be installed but not on PATH (fresh install / per-user setup)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
  goto RUN
)

echo.
echo   Node.js was not found on this computer.
echo.
if exist "runtime\node-v24.21.0-x64.msi" (
  echo   An offline installer is bundled with this project:
  echo       runtime\node-v24.21.0-x64.msi
  echo.
  echo   It is being opened now. Finish the setup wizard,
  echo   then close this window and double-click this file again.
  echo.
  start "" "runtime\node-v24.21.0-x64.msi"
  pause
  exit /b
)

echo   Please install Node.js 18+ from https://nodejs.org
echo   then run this file again.
echo.
pause
exit /b

:RUN
"%NODEEXE%" bili-helper.js
pause
