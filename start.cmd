@echo off
rem Start the course and open it in the default browser.
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:7878"
node server.mjs
