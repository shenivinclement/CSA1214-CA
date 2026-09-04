@echo off
title 8085/8086 Virtual Trainer - Backend Server
cd /d "%~dp0"

echo.
echo   ================================================
echo    8085/8086 Virtual Trainer  -  Backend Server
echo   ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js was not found on this computer.
  echo.
  echo   Install it from https://nodejs.org  ^(LTS version^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo   Node.js %NODEVER% detected.
echo.
echo   App        http://localhost:3000
echo   API        http://localhost:3000/api/health
echo              POST /api/assemble
echo              POST /api/run
echo.
echo   The browser will open automatically in a moment.
echo   Leave this window OPEN while you demo.
echo   Press Ctrl+C or close this window to stop the server.
echo.
echo   ------------------------------------------------
echo.

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

node server.mjs 3000

echo.
echo   Server stopped.
pause
