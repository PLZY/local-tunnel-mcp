@echo off
cd /d "%~dp0"
node src\launcher.js start
if errorlevel 1 pause
