# Distill + train on an EXISTING realistic scenario dir (no generation, no new spend).
# ASCII-only on purpose: PowerShell 5.1 mis-parses UTF-8-no-BOM Chinese comments.
#
# Why this exists: rebuild-realistic-data.ps1 regenerates scenarios (costs money).
# Once scenarios are on disk and paid for, use THIS script to (re)build the SFT
# dataset and train - distillation is the only spend, and it is incremental
# (already-distilled scenario#batch pairs are skipped).
#
# Usage:
#   powershell -File train\train-real-dataset.ps1                      # plan only
#   powershell -File train\train-real-dataset.ps1 -Yes                 # distill (+train)
#   powershell -File train\train-real-dataset.ps1 -Yes -Train
param(
    [string]$Dir = "train\data\scenarios-real",
    [string]$SftOut = "sft-real.jsonl",
    [string]$ModelDir = "train\models\qwen3-1.7b-sft-real",
    [int]$MaxCandidates = 13,
    [int]$Epochs = 1,
    [switch]$Yes,
    [switch]$Train
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONPATH = Join-Path $root "train\pylibs-gpu"

$scen = @(Get-ChildItem $Dir -Filter *.json -ErrorAction SilentlyContinue).Count
$sftPath = Join-Path $root "train\data\$SftOut"
$have = 0
if (Test-Path $sftPath) { $have = @(Get-Content $sftPath | Measure-Object -Line).Lines }

Write-Host "=== plan ===" -ForegroundColor Cyan
Write-Host ("  scenarios : {0} files in {1}" -f $scen, $Dir)
Write-Host ("  sft set   : train\data\{0}  (currently {1} pairs; incremental)" -f $SftOut, $have)
Write-Host ("  distill   : est ~RMB {0} (RMB 0.0016/pair, only for NEW pairs)" -f [math]::Round([math]::Max(0, $scen * 2.4 - $have) * 0.0016, 1))
if ($Train) {
    Write-Host ("  train     : {0}  (1 epoch ~ {1}h)" -f $ModelDir, [math]::Round(($scen * 2.4) / 16 * 105 / 3600, 1))
}
if (-not $Yes) {
    Write-Host "`nDRY RUN. Add -Yes to distill (and -Train to also train)." -ForegroundColor Yellow
    exit 0
}

if (-not $env:LLM_API_KEY -and -not (Select-String -Path .env -Pattern '^LLM_API_KEY=sk-' -Quiet)) {
    throw "No DeepSeek key found. Set env LLM_API_KEY / LLM_BASE_URL / LLM_MODEL first."
}
if (-not $env:LLM_BASE_URL) { $env:LLM_BASE_URL = 'https://api.deepseek.com/v1' }
if (-not $env:LLM_MODEL) { $env:LLM_MODEL = 'deepseek-chat' }

Write-Host "`n=== [1/2] distillation (incremental) ===" -ForegroundColor Cyan
node train\dist\train\gen-sft-data.js --dir $Dir --out $SftOut --max-candidates $MaxCandidates
if ($LASTEXITCODE -ne 0) { throw "distillation failed" }

if ($Train) {
    Write-Host "`n=== [2/2] QLoRA training ===" -ForegroundColor Cyan
    Write-Host "  NOTE: no inference server may hold the GPU at the same time." -ForegroundColor Yellow
    python train\extract\sft_qwen3.py --data $sftPath --drop-over-seq --epochs $Epochs --seq 3072 --no-unsloth --save-steps 25 --out $ModelDir
    if ($LASTEXITCODE -ne 0) { throw "training failed" }
    Write-Host ("`nAcceptance: powershell -File train\run_acceptance.ps1 -Model " + (Split-Path -Leaf $ModelDir)) -ForegroundColor Green
}
