$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  Write-Host '需要已安装 Python 3（py launcher）。' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path '.\.venv\Scripts\python.exe')) {
  py -3 -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install -U pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
Write-Host "OK: $($PWD.Path)" -ForegroundColor Green
Write-Host '重启 ClassRep 后端即可。'
