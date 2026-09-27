# ClassRep bootstrap (called by the root start .bat). ASCII-only on purpose:
# Windows PowerShell 5.1 reads BOM-less scripts as ANSI, so no Chinese text in this file.
#
# 1) Find a usable node.exe:
#      runtime\node.exe  ->  system node (v22.15 .. v24.x, needs corepack)  ->  download portable Node to runtime\
# 2) Run scripts\launcher.mjs with it (install deps / build if needed, then start the server).
#
# No admin rights, no registry writes, nothing installed outside this folder.
param([Parameter(ValueFromRemainingArguments = $true)] $Rest)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root 'runtime'
$LogDir = Join-Path $Root 'data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'launcher.log'

function Say([string]$msg) {
  Write-Host $msg
  Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format 's'), $msg) -Encoding UTF8
}

$versions = Get-Content (Join-Path $PSScriptRoot 'versions.json') -Raw | ConvertFrom-Json
$NodeVersion = $versions.node.version            # e.g. v24.17.0

function Test-SystemNode {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try { $v = (& $cmd.Source -v).Trim() } catch { return $null }
  if ($v -notmatch '^v(\d+)\.(\d+)\.') { return $null }
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]
  # node:sqlite + system CA API need >= 22.15; corepack was removed from Node 25+
  $ok = ($major -eq 22 -and $minor -ge 15) -or ($major -ge 23 -and $major -le 24)
  if (-not $ok) { return $null }
  return $cmd.Source
}

function Get-PortableNode {
  $zipName = "node-$NodeVersion-win-x64"
  $tmp = Join-Path $env:TEMP "classrep-$zipName.zip"
  $sums = $null
  foreach ($base in $versions.node.mirrors) {
    try {
      Say "Downloading Node.js $NodeVersion from $base ..."
      # SHASUMS always from nodejs.org when reachable, so a mirror cannot swap the file
      if (-not $sums) {
        try { $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -TimeoutSec 20).Content } catch { }
        if (-not $sums) { $sums = (Invoke-WebRequest -UseBasicParsing "$base/$NodeVersion/SHASUMS256.txt" -TimeoutSec 20).Content }
      }
      Invoke-WebRequest -UseBasicParsing "$base/$NodeVersion/$zipName.zip" -OutFile $tmp -TimeoutSec 600
      $want = ($sums -split "`n" | Where-Object { $_ -match "\s$zipName\.zip$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
      $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
      if (-not $want -or $got -ne $want.ToLower()) { throw "SHA256 mismatch" }
      # Extract inside the repo (same volume as runtime\): Move-Item cannot move
      # directories across drives, and %TEMP% is usually on C: while the repo may be on D:/E:.
      $extract = Join-Path $Root 'runtime.download'
      if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $extract | Out-Null
      # tar (bsdtar, Windows 10 1803+) is much faster than Expand-Archive.
      # Relax EAP here: in PS 5.1 a native command writing to stderr can become a terminating error.
      $extracted = $false
      if (Get-Command tar -ErrorAction SilentlyContinue) {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & tar -xf $tmp -C $extract 2>$null
        $extracted = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = $prevEap
      }
      if (-not $extracted) { Expand-Archive -Path $tmp -DestinationPath $extract -Force }
      if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
      Move-Item (Join-Path $extract $zipName) $Runtime
      Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      Say "Node.js $NodeVersion ready in runtime\"
      return (Join-Path $Runtime 'node.exe')
    } catch {
      Say "  failed: $($_.Exception.Message)"
    }
  }
  throw "Could not download Node.js. Check your network, or install Node.js 24 LTS from https://nodejs.org and run again."
}

try {
  $node = Join-Path $Runtime 'node.exe'
  if (-not (Test-Path $node)) {
    $node = Test-SystemNode
    if (-not $node) { $node = Get-PortableNode }
  }
  & $node (Join-Path $PSScriptRoot 'launcher.mjs') @Rest
  exit $LASTEXITCODE
} catch {
  Say "ERROR: $($_.Exception.Message)"
  exit 1
}
