@echo off
setlocal
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-agent-team.ps1"
if errorlevel 1 pause
