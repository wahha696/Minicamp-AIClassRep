[CmdletBinding()]
param(
  [string]$InstallDirectory = (Get-Location).Path,
  [switch]$AutomatedOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Ask([string]$Id, [string]$Prompt) {
  while ($true) {
    $answer = (Read-Host "$Prompt [y/n]").Trim().ToLowerInvariant()
    if ($answer -in @('y', 'yes')) { return [ordered]@{ id = $Id; passed = $true } }
    if ($answer -in @('n', 'no')) { return [ordered]@{ id = $Id; passed = $false } }
  }
}

$root = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$pathHasSpace = $root.Contains(' ')
$pathHasUnicode = $root.ToCharArray() | Where-Object { [int]$_ -gt 127 } | Select-Object -First 1
$privilegeDetail = if ($isAdmin) { '当前进程是管理员' } else { '普通用户权限' }
$versionPath = Join-Path $root 'app\version.json'
$version = if (Test-Path -LiteralPath $versionPath) {
  [string]((Get-Content -LiteralPath $versionPath -Raw -Encoding UTF8 | ConvertFrom-Json).version)
} else { '' }

$checks = @(
  [ordered]@{ id = 'ordinary_user'; passed = (-not $isAdmin); detail = $privilegeDetail },
  [ordered]@{ id = 'unicode_space_path'; passed = ($pathHasSpace -and $null -ne $pathHasUnicode); detail = $root },
  [ordered]@{ id = 'launcher_present'; passed = (Test-Path -LiteralPath (Join-Path $root '启动.bat')); detail = '启动.bat' },
  [ordered]@{ id = 'portable_node_present'; passed = (Test-Path -LiteralPath (Join-Path $root 'runtime\node.exe')); detail = 'runtime/node.exe' },
  [ordered]@{ id = 'rescue_present'; passed = ((Test-Path -LiteralPath (Join-Path $root '修复升级.bat')) -and (Test-Path -LiteralPath (Join-Path $root '修复升级.ps1'))); detail = '修复升级入口' }
)

if (-not $AutomatedOnly) {
  Write-Host ''
  Write-Host '请在普通 Windows 10/11 用户、包含中文和空格的目录中执行。'
  Write-Host '测试消息请使用专门的测试群，不要在报告里填写 QQ 号、群号、姓名或消息原文。'
  Write-Host ''
  $checks += Ask 'first_launch' '首次双击启动后，是否无需安装 Node/pnpm/Git 且向导页可打开？'
  $checks += Ask 'qr_login' '手机扫码后，连接状态和群列表是否正确出现？'
  $checks += Ask 'new_event' '发送一条测试通知后，是否只生成一条字段正确的日程？'
  $checks += Ask 'reschedule' '发送改期通知后，是否更新原日程并保留来源/历史，而非新增重复日程？'
  $checks += Ask 'cancel_or_pending' '发送取消或低置信度变更后，是否正确取消或进入可操作的待确认？'
  $checks += Ask 'account_switch' 'A→B→A 换号后，两个账号的数据是否完全隔离且切回后原样恢复？'
  $checks += Ask 'return_qq' '返回电脑版 QQ 再返回 ClassRep 后，是否恢复连接并补读离开期间的测试消息？'
  $checks += Ask 'auto_upgrade' '准备待更新包并重启后，是否升级成功且 data、账号、课表和设置均保留？'
}

$reportDir = Join-Path $root 'data\acceptance'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$report = [ordered]@{
  schema_version = 1
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  windows = [Environment]::OSVersion.VersionString
  version = $version
  install_path_shape = [ordered]@{ has_space = $pathHasSpace; has_non_ascii = ($null -ne $pathHasUnicode) }
  elevated = $isAdmin
  checks = $checks
  passed = (@($checks | Where-Object { -not $_.passed }).Count -eq 0)
}
$reportPath = Join-Path $reportDir ("windows-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ''
Write-Host "验收报告：$reportPath"
if (-not $report.passed) {
  Write-Error '有验收项未通过；本报告不能作为发布放行证据。'
  exit 1
}
Write-Host '全部验收项通过。'
