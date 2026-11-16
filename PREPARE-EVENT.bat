@echo off
setlocal
title STEM FOR IMPACT 2026 - Prepare the event build
cd /d "%~dp0"
echo.
echo ======================================================================
echo   STEM FOR IMPACT 2026 - PREPARATION (run BEFORE the event, needs internet once)
echo ======================================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed. Install Node.js 20 LTS or newer from https://nodejs.org
  goto fail
)
echo [1/5] Installing the exact dependency versions from package-lock.json ...
call npm ci --no-audit --no-fund
if errorlevel 1 ( echo [X] Installation failed. & goto fail )
echo.
echo [2/5] Type-checking the source ...
call npm run typecheck
if errorlevel 1 ( echo [X] Type check failed. & goto fail )
echo.
echo [3/5] Running the automated tests (uses temporary folders, never data\) ...
call npm test
if errorlevel 1 ( echo [X] Tests failed. & goto fail )
echo.
echo [4/5] Building the dashboard ...
call npx vite build
if errorlevel 1 ( echo [X] Build failed. & goto fail )
echo.
echo [5/5] Verifying the build matches the source files ...
call npx tsx scripts/verify-build.ts
if errorlevel 1 goto fail
echo.
echo ======================================================================
echo   PREPARED. On event day just double-click START-EVENT.bat
echo   (no internet needed). Do not edit files in this folder after this.
echo ======================================================================
pause
exit /b 0

:fail
echo.
echo ======================================================================
echo   PREPARATION FAILED - do NOT use this copy for the event until fixed.
echo   Scroll up for the first error.
echo ======================================================================
pause
exit /b 1
