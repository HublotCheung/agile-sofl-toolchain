@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 18 or newer, then run this script again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled, then run this script again.
  exit /b 1
)

echo Installing locked workspace dependencies...
call npm ci
if errorlevel 1 exit /b 1

echo Building the Windows installer. Templates and the language server are staged by the Studio build.
call npm run build:win
if errorlevel 1 exit /b 1

echo.
echo Windows installer is available in packages\studio\release\
exit /b 0
