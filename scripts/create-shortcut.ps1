# 在桌面创建「AI 课代表」快捷方式：双击 = 启动.bat（生产构建；关窗口即退出）
# 想边开发边看日志就用 scripts\dev-start.bat（前台 tsx）
# 用法：pnpm shortcut ，或右键本文件 → 使用 PowerShell 运行
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'AI 课代表.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $root '启动.bat'
$s.WorkingDirectory = $root
$s.IconLocation = "$env:WINDIR\System32\shell32.dll,137"
$s.Save()
Write-Host "已在桌面创建快捷方式：$lnk"
