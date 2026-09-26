@echo off
chcp 65001 >nul
title ClassRep（关闭此窗口即退出）
cd /d "%~dp0"
"runtime\node.exe" "app\server\dist\index.js"
