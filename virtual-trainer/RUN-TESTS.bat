@echo off
title 8085/8086 Virtual Trainer - Test Suite
cd /d "%~dp0"

echo.
echo   ================================================
echo    8085/8086 Virtual Trainer  -  Test Suite
echo   ================================================
echo.
echo   Runs the CPU engine tests and the live REST API
echo   tests ^(the API tests boot a real server^).
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js was not found. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node --test "tests/**/*.test.js"

echo.
echo   ------------------------------------------------
echo   Done. Look for "pass" and "fail" counts above.
echo.
pause
