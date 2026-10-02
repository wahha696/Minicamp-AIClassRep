@echo off
rem ClassRep 一键启动（问题 2：自适应启动）。本文件必须是 UTF-8（带 BOM 亦可）保存。
rem 两种布局都支持：
rem   · 免安装包：runtime\node.exe + app\server\dist\index.js → 直接跑（先套用待安装的更新）
rem   · 克隆仓库：找一个 ≥22.13 的 Node（PATH 里的 / runtime\ 的），没有就自动下载到 runtime\node.exe，
rem               然后跑 scripts\bootstrap.mjs（装依赖 → 补 NapCat → 增量构建前端 → 起后端 → 开浏览器）
rem 环境变量：NODE_MIRROR=Node 下载镜像（如 https://npmmirror.com/mirrors/node）
setlocal EnableExtensions
chcp 65001 >nul
title ClassRep（关闭此窗口即退出）
cd /d "%~dp0"

rem ===== 0. 先恢复被中断的更新，恢复入口不能依赖 app/ 或 runtime/ 是否完整 =====
if exist "data\update\transaction.json" goto :recoverUpdate
goto :detectLayout

:recoverUpdate
if not exist "data\update\recover.mjs" goto :updateFailed
if not exist "data\update\recovery-node.exe" goto :updateFailed
"data\update\recovery-node.exe" "data\update\recover.mjs" --recover-only
if errorlevel 1 goto :updateFailed
goto :startPackaged

:detectLayout
rem ===== 免安装包布局：应用待安装的更新 → 直接跑打包产物 =====
if not exist "runtime\node.exe" goto :repo
if not exist "app\server\dist\index.js" goto :repo
if exist "runtime\node.exe.old" del /q "runtime\node.exe.old" >nul 2>nul
if exist "data\update\pending.json" if exist "app\update.mjs" (
  echo [ClassRep] 检测到新版本，正在应用更新...
  "runtime\node.exe" "app\update.mjs"
)
rem 回滚没有完成时不能继续运行混合版本，也不能删除备份。
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
rem ===== 克隆仓库布局：定位可用的 Node（需要 node:sqlite，即 ≥22.13） =====
set "NODE_EXE="
node -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if defined NODE_EXE goto :run

if exist "runtime\node.exe" (
  "runtime\node.exe" -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=runtime\node.exe"
)
if defined NODE_EXE goto :run

rem 之前下过完整 zip 版的话直接复用（runtime\node-v*-win-x64\node.exe）
for /d %%d in ("runtime\node-v*-win-x64") do (
  if not defined NODE_EXE (
    "%%d\node.exe" -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=%%d\node.exe"
  )
)
if defined NODE_EXE goto :run

echo [ClassRep] 没有找到可用的 Node.js（需要 22.13+），自动下载到 runtime\（约 40MB，只下载一次）...
if not exist "runtime" mkdir "runtime"
rem 先下完整发行包 zip（带 npm/corepack，bootstrap 才装得上依赖）
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $base=$env:NODE_MIRROR; if(-not $base){$base='https://nodejs.org/dist'}; Invoke-WebRequest -UseBasicParsing ($base.TrimEnd('/')+'/v24.19.0/node-v24.19.0-win-x64.zip') -OutFile 'runtime\node.zip'"
if not errorlevel 1 (
  tar -xf "runtime\node.zip" -C "runtime" >nul 2>nul
  del /q "runtime\node.zip" >nul 2>nul
)
if exist "runtime\node-v24.19.0-win-x64\node.exe" goto :zipok
rem zip 下载/解压失败 → 退回裸 node.exe（bootstrap 会自动下载 pnpm，照样能用）
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
"%NODE_EXE%" "scripts\bootstrap.mjs" %*
exit /b %errorlevel%
