@echo off
chcp 65001 >nul
title AI 课代表（关闭此窗口即退出）
cd /d "%~dp0"
rem One-click start. Logic lives in scripts\bootstrap.ps1 and scripts\launcher.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" %*
if errorlevel 1 (
  echo.
  echo 启动失败。详细记录在 data\logs\launcher.log ，可以把它发给开发同学。
  pause
  exit /b 1
)