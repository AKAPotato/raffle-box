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
echo   Bilibili comment drawing needs Node.js 18+ (LTS is fine).
echo   Please download and install it from the official website:
echo.
echo       https://nodejs.org/zh-cn/download
echo.
echo   Keep the default options during setup (this adds node to PATH).
echo   When finished, close this window and double-click this file again.
echo.
pause
exit /b

:RUN
"%NODEEXE%" bili-helper.js
pause
