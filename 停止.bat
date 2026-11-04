@echo off
cd /d "%~dp0"
node src\launcher.js stop
if errorlevel 1 pause
