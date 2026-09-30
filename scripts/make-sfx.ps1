# ClassRep 单文件 exe 构建脚本（在 scripts/pack.mjs 产出 release/ClassRep.zip 之后运行）
# 产物：release/ClassRep.exe —— 双击自解压安装到 %LOCALAPPDATA%\ClassRep，建桌面快捷方式并启动
#
# 原理（全部使用官方组件，无第三方依赖）：
#   ClassRep.exe = 7zSD.sfx（LZMA SDK 的安装器 SFX 模块）+ config.txt + app.7z
#   双击后：7zSD 解压 app.7z 到 %TEMP%\7zSxxxx → 按 config 的 RunProgram 启动 wscript launch-install.vbs
#   → install.ps1 停旧服务 → robocopy 同步到 %LOCALAPPDATA%\ClassRep → 建桌面快捷方式 → 隐藏启动 node
#
# 用法：pwsh -File scripts\make-sfx.ps1            （用现有 release/ClassRep.zip）
#       pwsh -File scripts\make-sfx.ps1 -Repack    （先重新 pnpm pack:win 再转 exe）
#       pwsh -File scripts\make-sfx.ps1 -FetchTools（tools/ 缺 7zr/7zSD 时自动从 7-zip.org 下载）
param([switch]$Repack, [switch]$FetchTools)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repo 'release\sfx-build'
$tools = Join-Path $build 'tools'
$zipPath = Join-Path $repo 'release\ClassRep.zip'
$exePath = Join-Path $repo 'release\ClassRep.exe'

if ($Repack) {
    & cmd /c "pnpm pack:win"
    if ($LASTEXITCODE -ne 0) { throw 'pnpm pack:win failed' }
}
if (-not (Test-Path $zipPath)) { throw "missing $zipPath - run scripts/pack.mjs first" }

# 0) 工具就位（7zr.exe + sdk/bin/7zSD.sfx，均来自 7-zip.org 官方下载，已缓存在 tools/）
#    缓存在 release/sfx-build/tools/，首次用 -FetchTools 自动从 7-zip.org 下载补齐
if ($FetchTools) {
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    if (-not (Test-Path $7zr)) {
        Invoke-WebRequest 'https://www.7-zip.org/a/7zr.exe' -OutFile $7zr
    }
    if (-not (Test-Path $sfx)) {
        $lzma = Join-Path $tools 'lzma.7z'
        Invoke-WebRequest 'https://www.7-zip.org/a/lzma2603.7z' -OutFile $lzma
        tar -xf $lzma -C $tools
        Remove-Item $lzma -Force -ErrorAction SilentlyContinue
    }
}
$7zr = Join-Path $tools '7zr.exe'
$sfx = Join-Path $tools 'sdk\bin\7zSD.sfx'
if (-not (Test-Path $7zr))  { throw "missing $7zr (下载 https://www.7-zip.org/a/7zr.exe 到 tools/，或加 -FetchTools 自动下载)" }
if (-not (Test-Path $sfx))  { throw "missing $sfx (下载 https://www.7-zip.org/a/lzma2603.7z 并解出 bin/7zSD.sfx 到 tools/sdk/bin/，或加 -FetchTools)" }

# 1) 解压 zip 到 payload（覆盖旧暂存）；pack.mjs 的 zip 顶层就是 ClassRep\
$payload = Join-Path $build 'payload'
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null
tar -xf $zipPath -C $payload
if (-not (Test-Path (Join-Path $payload 'ClassRep\app\server\dist\index.js'))) {
    throw 'zip 内容与预期不符：缺 ClassRep\app\server\dist\index.js（请用最新 scripts/pack.mjs 出的包）'
}

# 2) 按最新打包规则清理 napcat 账号数据（旧 zip 可能包含，不得对外分发）
$nap = Join-Path $payload 'ClassRep\napcat'
foreach ($n in 'config','cache','logs','guild1.db','guild1.db-shm','guild1.db-wal','loadNapCat.js') {
    Remove-Item (Join-Path $nap $n) -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem $nap -Filter '*.log' -ErrorAction SilentlyContinue | Remove-Item -Force

# 3) 注入脚本（ASCII-only 源文件在本目录 sfx-assets/，避免编码问题）
#    布局：launch-install.vbs / install.ps1 放 payload 根（SFX 解压根目录，供 ExecuteFile 调用）；
#          start-hidden.vbs / stop-server.ps1 / stop.bat 放 ClassRep\（随程序安装，供日常使用）
$assets = Join-Path $PSScriptRoot 'sfx-assets'
Copy-Item (Join-Path $assets 'launch-install.vbs') $payload -Force
Copy-Item (Join-Path $assets 'install.ps1')    $payload -Force
foreach ($f in 'start-hidden.vbs','stop-server.ps1','stop.bat') {
    Copy-Item (Join-Path $assets $f) (Join-Path $payload 'ClassRep') -Force
}

# 4) 压缩 app.7z —— 注意：安装器脚本（launch-install.vbs / install.ps1）在 payload 根目录，
#    ExecuteFile 在 SFX 解压根目录找它们，所以必须把这两个文件一起打进 7z（只打 ClassRep 会找不到）
$app7z = Join-Path $build 'app.7z'
Remove-Item $app7z -Force -ErrorAction SilentlyContinue
Push-Location $payload
& $7zr a -y -mx=9 -ms=on $app7z ClassRep launch-install.vbs install.ps1 | Out-Null
Pop-Location
if ($LASTEXITCODE -ne 0) { throw '7zr compression failed' }

# 5) 生成 config.txt（7zSD 的安装器配置：UTF-8，首尾标记不可少），再拼接
#    ClassRep.exe = 7zSD.sfx + config.txt + app.7z
$config = Join-Path $build 'config.txt'
# 7zSD 要求 config 以 ";!@Install@!UTF-8!" 开头——必须无 BOM（PS5.1 的 -Encoding utf8 会带 BOM）
$cfg = @'
;!@Install@!UTF-8!
Title="ClassRep - AI 课代表"
BeginPrompt="安装 ClassRep 到本机并启动？"
Progress="yes"
RunProgram="wscript.exe launch-install.vbs"
;!@InstallEnd@!
'@
[IO.File]::WriteAllText($config, ($cfg -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
Remove-Item $exePath -Force -ErrorAction SilentlyContinue
cmd /c copy /b "`"$sfx`"+`"$config`"+`"$app7z`"" "`"$exePath`"" | Out-Null
if (-not (Test-Path $exePath) -or (Get-Item $exePath).Length -lt (Get-Item $app7z).Length) {
    throw 'SFX 拼接失败：ClassRep.exe 未生成或异常'
}

$mb = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-Host "OK  $exePath  ($mb MB)"
Write-Host '验收：拷到没装过 Node 的电脑，双击 → 自动安装并打开浏览器。'
