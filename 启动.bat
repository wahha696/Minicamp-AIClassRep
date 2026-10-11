@echo off
chcp 65001 >nul
rem ClassRep launcher: keep batch comments ASCII for legacy Windows consoles.
rem Runtime downloads remain local to this installation; see docs for setup.
setlocal EnableExtensions
title ClassRep（关闭此窗口即退出）
cd /d "%~dp0"

if exist "data\update\transaction.json" goto :recoverUpdate
rem Recover interrupted updates before inspecting the installed layout.
goto :detectLayout
rem Packaged layout runs the bundled backend; source layout bootstraps dependencies.

:recoverUpdate
if not exist "data\update\recover.mjs" goto :updateFailed
rem Preserve recovery backups when repair cannot complete.
if not exist "data\update\recovery-node.exe" goto :updateFailed
"data\update\recovery-node.exe" "data\update\recover.mjs" --recover-only
if errorlevel 1 goto :updateFailed
goto :startPackaged
rem Run a complete installed package after any pending recovery.

:detectLayout
if not exist "runtime\node.exe" goto :repo
rem Locate a Node runtime with the required SQLite APIs, or download it locally.
if not exist "app\server\dist\index.js" goto :repo
if exist "runtime\node.exe.old" del /q "runtime\node.exe.old" >nul 2>nul
if exist "data\update\pending.json" if exist "app\update.mjs" (
  echo [ClassRep] 检测到新版本，正在应用更新...
  "runtime\node.exe" "app\update.mjs"
)
if exist "data\update\transaction.json" goto :recoverUpdate

:startPackaged
if not exist "runtime\node.exe" goto :updateFailed
if not exist "app\server\dist\index.js" goto :updateFailed
if exist "data\update\recovery-node.exe" del /q "data\update\recovery-node.exe" >nul 2>nul
set "CLASSREP_OPEN_BROWSER=1"
"runtime\node.exe" "app\server\dist\index.js" %*
exit /b %errorlevel%

:updateFailed
echo [ClassRep] 更新恢复尚未完成，已保留 data\update 中的备份。请关闭其他 ClassRep 进程后重试。
pause
exit /b 1

:repo
set "NODE_EXE="
node "scripts\lib\node-runtime.mjs" --check >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if defined NODE_EXE goto :run
rem Expose the selected portable Node to dependency and build subprocesses.

if exist "runtime\node.exe" (
  "runtime\node.exe" "scripts\lib\node-runtime.mjs" --check >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=runtime\node.exe"
)
if defined NODE_EXE goto :run

for /d %%d in ("runtime\node-v*-win-x64") do (
  if not defined NODE_EXE (
    "%%d\node.exe" "scripts\lib\node-runtime.mjs" --check >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=%%d\node.exe"
  )
)
if defined NODE_EXE goto :run

echo [ClassRep] 没有找到可用的 Node.js（需要 22.16+），自动下载到 runtime\（约 40MB，只下载一次）...
if not exist "runtime" mkdir "runtime"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $base=$env:NODE_MIRROR; if(-not $base){$base='https://nodejs.org/dist'}; Invoke-WebRequest -UseBasicParsing ($base.TrimEnd('/')+'/v24.19.0/node-v24.19.0-win-x64.zip') -OutFile 'runtime\node.zip'"
if not errorlevel 1 (
  tar -xf "runtime\node.zip" -C "runtime" >nul 2>nul
  del /q "runtime\node.zip" >nul 2>nul
)
if exist "runtime\node-v24.19.0-win-x64\node.exe" goto :zipok
rem Use the full official distribution when extraction succeeded.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $base=$env:NODE_MIRROR; if(-not $base){$base='https://nodejs.org/dist'}; Invoke-WebRequest -UseBasicParsing ($base.TrimEnd('/')+'/v24.19.0/win-x64/node.exe') -OutFile 'runtime\node.exe'"
if errorlevel 1 (
  echo.
  echo [ClassRep] ❌ Node 下载失败。
  echo    办法一：设置镜像后重试，例如  setx NODE_MIRROR "https://npmmirror.com/mirrors/node"
  echo    办法二：手动下载 https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip
  echo            解压后把 node-v24.19.0-win-x64 整个文件夹放进本目录的 runtime\，再重新双击 启动.bat
  pause
  exit /b 1
)
set "NODE_EXE=runtime\node.exe"
goto :run
:zipok
set "NODE_EXE=runtime\node-v24.19.0-win-x64\node.exe"

:run
if /i not "%NODE_EXE%"=="node" for %%d in ("%NODE_EXE%") do set "PATH=%%~dpd;%PATH%"
"%NODE_EXE%" "scripts\bootstrap.mjs" %*
exit /b %errorlevel%
