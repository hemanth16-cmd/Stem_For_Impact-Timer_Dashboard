@echo off
setlocal
title STEM FOR IMPACT 2026 - Countdown Server (KEEP THIS WINDOW OPEN)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 ( echo [X] Node.js is not installed on this laptop. & pause & exit /b 1 )
if not exist node_modules\tsx\ (
  echo [X] This copy has not been prepared. Run PREPARE-EVENT.bat first ^(needs internet once^).
  pause & exit /b 1
)
if not exist dist\build-info.json (
  echo [X] No prepared build found. Run PREPARE-EVENT.bat first.
  pause & exit /b 1
)
echo Starting the event server. Leave this window OPEN for the whole event.
echo Closing it stops sync (open displays keep counting, but announcements stop updating).
echo.
node --import tsx server\index.ts
echo.
echo ======================================================================
echo   The server has STOPPED. Read the message above.
echo   To restart: double-click START-EVENT.bat again (state is restored from data\).
echo ======================================================================
pause
