@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 echo. & echo Something went wrong. Please send a screenshot of this window to your Phoenix team.
pause
