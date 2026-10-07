@echo off
setlocal
chcp 65001 >nul
title ClassRep 旧版升级救援

if not exist "%~dp0修复升级.ps1" (
  echo [错误] 找不到“修复升级.ps1”。请把两个修复文件放在同一个 ClassRep 目录里。
  goto :fail
)

echo 请先关闭原来的 ClassRep 启动窗口。
echo 本工具会校验最新版、完整备份 data，再替换程序文件；不会覆盖账号数据。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0修复升级.ps1" -InstallDirectory "%~dp0"
if errorlevel 1 goto :fail

echo.
echo 修复完成，可以重新双击“启动.bat”。
if not "%CLASSREP_RESCUE_NO_PAUSE%"=="1" pause
exit /b 0

:fail
echo.
echo 修复没有完成，原数据仍保留。请查看上面的错误提示。
if not "%CLASSREP_RESCUE_NO_PAUSE%"=="1" pause
exit /b 1

