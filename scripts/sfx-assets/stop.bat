@echo off
rem Stop the ClassRep background server (no window is left running).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1"
pause
