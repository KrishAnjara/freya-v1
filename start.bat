@echo off
rem Starts FREYA on Windows. Double-click this file, or run: start.bat [--prod] [--format chatml]
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
node scripts\start.mjs %*
if errorlevel 1 pause
