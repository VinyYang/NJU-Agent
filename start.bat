@echo off
rem NJU CodePilot Windows launcher.  Keeps the backend on an isolated port,
rem stops a stale instance, and opens the bundled frontend in the browser.
rem Credentials are read from the ignored .env file; never put an API key here.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
