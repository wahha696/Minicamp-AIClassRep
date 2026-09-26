# 在桌面创建「ClassRep 启动」快捷方式（双击 = 一键启动 / 重启）
# 用法：pnpm shortcut ，或右键本文件 → 使用 PowerShell 运行
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'ClassRep 启动.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = "$env:WINDIR\System32\cmd.exe"
$s.Arguments = '/c ""' + (Join-Path $root 'scripts\dev-start.bat') + '""'
$s.WorkingDirectory = $root
$s.IconLocation = "$env:WINDIR\System32\shell32.dll,137"
$s.Save()
Write-Host "已在桌面创建快捷方式：$lnk"
