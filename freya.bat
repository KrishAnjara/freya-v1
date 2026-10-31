@echo off
rem FREYA's switches. Double-click for the menu, or run: freya on swearing, freya off swearing, freya server URL KEY, freya local, freya start
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
node scripts\freya.mjs %*
