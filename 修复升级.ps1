[CmdletBinding()]
param(
  [string]$InstallDirectory = $PSScriptRoot,
  [string]$PackagePath = '',
  [string]$ManifestPath = '',
  [string]$ReleaseTag = 'latest',
  [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Message) {
  Write-Host "[ClassRep Rescue] $Message"
}

function Full-Path([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-SafeInstall([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root) -or $Root -eq [IO.Path]::GetPathRoot($Root)) {
    throw '安装目录不安全，拒绝操作磁盘根目录。'
  }
  foreach ($required in @('启动.bat', 'app', 'data')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $required))) {
      throw "这不是可修复的 ClassRep 安装目录：缺少 $required"
    }
  }
}

function Assert-NotRunning([string]$Root) {
  try {
    $prefix = $Root + [IO.Path]::DirectorySeparatorChar
    $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.ProcessId -ne $PID -and $_.ExecutablePath -and
      (Full-Path ([string]$_.ExecutablePath)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($running.Count -gt 0) {
      $names = ($running | ForEach-Object { "$($_.Name) (PID $($_.ProcessId))" }) -join '、'
      throw "ClassRep 仍在运行：$names。请先关闭启动窗口和 ClassRep，再重试。"
    }
  } catch {
    if ($_.Exception.Message -like 'ClassRep 仍在运行*') { throw }
    Write-Step '无法枚举进程，将继续；如果文件被占用，切换会失败并自动回滚。'
  }
}

function Download-Release([string]$Workspace, [string]$Tag) {
  $base = if ($Tag -eq 'latest') {
    'https://github.com/wahha696/Minicamp-AIClassRep/releases/latest/download'
  } else {
    "https://github.com/wahha696/Minicamp-AIClassRep/releases/download/$Tag"
  }
  $zip = Join-Path $Workspace 'ClassRep.zip'
  $manifest = Join-Path $Workspace 'ClassRep.manifest.json'
  Write-Step "下载 $Tag 发布包…"
  Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'ClassRep-Rescue' } -Uri "$base/ClassRep.manifest.json" -OutFile $manifest
  Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'ClassRep-Rescue' } -Uri "$base/ClassRep.zip" -OutFile $zip
  return @($zip, $manifest)
}

function Resolve-Package([string]$Workspace) {
  if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    return Download-Release $Workspace $ReleaseTag
  }
  $zip = Full-Path $PackagePath
  if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "找不到更新包：$zip" }
  $manifest = if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    Join-Path (Split-Path $zip -Parent) 'ClassRep.manifest.json'
  } else {
    Full-Path $ManifestPath
  }
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw '离线修复必须同时提供 ClassRep.manifest.json，不能跳过完整性校验。'
  }
  return @($zip, $manifest)
}

function Verify-Package([string]$Zip, [string]$Manifest) {
  $info = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not ($info.sha256 -is [string]) -or $info.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw '发布清单缺少合法 SHA-256。'
  }
  $actualHash = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$info.sha256).ToLowerInvariant()) {
    throw '更新包 SHA-256 不匹配，已停止，原安装未改动。'
  }
  if ($null -ne $info.size -and [int64]$info.size -ne (Get-Item -LiteralPath $Zip).Length) {
    throw '更新包大小与发布清单不一致，已停止，原安装未改动。'
  }
  return $info
}

function Copy-Entry([string]$Source, [string]$Destination) {
  $parent = Split-Path $Destination -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Assert-SafeEntryName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -in @('.', '..', 'data') -or
      $Name.Contains('/') -or $Name.Contains('\\') -or $Name.Contains(':')) {
    throw "恢复记录包含不安全路径：$Name"
  }
}

function Save-Journal([string]$Path, [object]$Journal) {
  $temp = "$Path.tmp"
  $Journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temp -Encoding UTF8
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Restore-Program([string]$Root, [string]$WorkRoot) {
  $journalPath = Join-Path $WorkRoot 'transaction.json'
  if (-not (Test-Path -LiteralPath $journalPath)) { return }
  $journal = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$journal.version -ne 1 -or [string]$journal.state -ne 'switching') {
    throw '救援恢复记录格式无效，已停止以免误删文件。'
  }
  $oldRoot = Join-Path $WorkRoot 'old'
  $newRoot = Join-Path $WorkRoot 'new'
  $failures = @()
  $entries = @($journal.entries)
  for ($i = $entries.Count - 1; $i -ge 0; $i--) {
    $entry = $entries[$i]
    try {
      $name = [string]$entry.name
      Assert-SafeEntryName $name
      $target = Join-Path $Root $name
      $old = Join-Path $oldRoot $name
      $prepared = Join-Path $newRoot $name
      if ([bool]$entry.had_original) {
        # old 存在说明原文件已移走；无论新文件是否已放入，都恢复原文件。
        if (Test-Path -LiteralPath $old) {
          if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
          Move-Item -LiteralPath $old -Destination $target
        }
      } elseif (-not (Test-Path -LiteralPath $prepared)) {
        # 原本不存在，prepared 又已消失，说明新文件可能已放入安装目录。
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      }
    } catch {
      $failures += "$($entry.name): $($_.Exception.Message)"
    }
  }
  if ($failures.Count -gt 0) {
    throw "自动回滚未完全成功，请保留 data\rescue-upgrade 并人工检查：$($failures -join '；')"
  }
  Remove-Item -LiteralPath $WorkRoot -Recurse -Force
}

$root = Full-Path $InstallDirectory
$workspace = Join-Path ([IO.Path]::GetTempPath()) ("classrep-rescue-" + [guid]::NewGuid().ToString('N'))
$work = Join-Path $root 'data\rescue-upgrade'
$backup = $null
$success = $false

try {
  Assert-SafeInstall $root
  Assert-NotRunning $root
  if (Test-Path -LiteralPath (Join-Path $work 'transaction.json')) {
    Write-Step '检测到上次中断的救援事务，先恢复旧程序…'
    Restore-Program $root $work
  } elseif (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $workspace | Out-Null
  $resolved = Resolve-Package $workspace
  $zip = [string]$resolved[0]
  $manifest = [string]$resolved[1]
  $info = Verify-Package $zip $manifest

  $extract = Join-Path $workspace 'extract'
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $source = if (Test-Path -LiteralPath (Join-Path $extract 'ClassRep')) {
    Join-Path $extract 'ClassRep'
  } else {
    $extract
  }
  foreach ($required in @('启动.bat', 'runtime\node.exe', 'app\server\dist\index.js', 'app\version.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required))) {
      throw "更新包结构不完整：缺少 $required。原安装未改动。"
    }
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path (Split-Path $root -Parent) "ClassRep-data-backup-$stamp"
  if (Test-Path -LiteralPath $backup) { throw "备份目录已存在：$backup" }
  Write-Step "备份用户数据到 $backup …"
  Copy-Item -LiteralPath (Join-Path $root 'data') -Destination $backup -Recurse

  $newRoot = Join-Path $work 'new'
  $oldRoot = Join-Path $work 'old'
  New-Item -ItemType Directory -Force -Path $newRoot, $oldRoot | Out-Null
  # 当前 cmd/PowerShell 正在读取救援入口；不要在本次运行中替换它们。
  $entries = @(Get-ChildItem -LiteralPath $source | Where-Object {
    $_.Name -ne 'data' -and $_.Name -notin @('修复升级.bat', '修复升级.ps1')
  })
  if ($entries.Count -eq 0) { throw '更新包没有可替换的程序文件。' }
  foreach ($entry in $entries) { Copy-Entry $entry.FullName (Join-Path $newRoot $entry.Name) }

  $journalEntries = @($entries | ForEach-Object {
    Assert-SafeEntryName $_.Name
    [ordered]@{ name = $_.Name; had_original = (Test-Path -LiteralPath (Join-Path $root $_.Name)) }
  })
  $journal = [ordered]@{
    version = 1
    state = 'switching'
    target_version = [string]$info.version
    backup = $backup
    entries = $journalEntries
  }
  Save-Journal (Join-Path $work 'transaction.json') $journal

  Write-Step "切换到 v$($info.version)…"
  try {
    foreach ($entry in $entries) {
      $target = Join-Path $root $entry.Name
      $old = Join-Path $oldRoot $entry.Name
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $old }
      Move-Item -LiteralPath (Join-Path $newRoot $entry.Name) -Destination $target
    }
    # 旧事务会在新版本首次启动时回滚刚修好的程序，成功救援前必须清除。
    $oldUpdate = Join-Path $root 'data\update'
    if (Test-Path -LiteralPath $oldUpdate) { Remove-Item -LiteralPath $oldUpdate -Recurse -Force }
  } catch {
    Write-Step "程序切换失败，正在恢复旧版：$($_.Exception.Message)"
    Restore-Program $root $work
    throw '升级失败，已恢复旧版；用户数据和备份均保留。'
  }

  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  $success = $true
  Write-Step "升级完成。用户数据未覆盖，完整备份位于：$backup"
  Write-Step '现在可以双击“启动.bat”。确认新版本正常后再手动删除备份。'
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if (Test-Path -LiteralPath $workspace) {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $success) { exit 1 }
