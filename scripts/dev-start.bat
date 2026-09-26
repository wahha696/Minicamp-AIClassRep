@echo off
chcp 65001 >nul
title ClassRep dev - close this window to quit
cd /d "%~dp0.."
rem One-click start / restart for development. Logic lives in scripts\dev.mjs.
node scripts\dev.mjs
pause
