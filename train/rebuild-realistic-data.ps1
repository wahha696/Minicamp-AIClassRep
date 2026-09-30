# Rebuild a REALISM-ALIGNED dataset and (optionally) train on it.
# ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8-no-BOM Chinese.
#
# Why: the v1-v4 datasets were generated BEFORE the generator learned the real
# distribution (see train/BATCH-SHAPE.md). Measured after the fix:
#   chunks/msg 5.0 vs real 5.9 | time-mentions 5.4% vs 6.0% | noise 72.5% vs 77.7%
#   candidates after BATCH=30 + isNoise: median 8 vs real 6
#
# Cost (measured on this machine, deepseek-chat, cache hit ~60-70%):
#   generation ~RMB 0.017 per scenario   -> 1500 scenarios ~ RMB 25
#   distillation ~RMB 5-8 per 1500 scenarios
# Run with -Yes to actually spend money; otherwise it only prints the plan.
#
# Usage:
#   powershell -File train\rebuild-realistic-data.ps1 -Scenarios 1500          # dry plan
#   powershell -File train\rebuild-realistic-data.ps1 -Scenarios 1500 -Yes     # generate + distill
#   powershell -File train\rebuild-realistic-data.ps1 -Scenarios 1500 -Yes -Train
param(
    [int]$Scenarios = 1500,
    [string]$OutDir = "train\data\scenarios-real",
    [string]$SftOut = "sft-real.jsonl",
    [string]$ModelDir = "train\models\qwen3-1.7b-sft-real",
    [int]$Epochs = 1,
    [int]$MaxCandidates = 13,
    [switch]$Yes,
    [switch]$Train
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONPATH = Join-Path $root "train\pylibs-gpu"

$genCost = [math]::Round($Scenarios * 0.016, 1)
$distCost = [math]::Round($Scenarios * 0.005, 1)
Write-Host "=== plan ===" -ForegroundColor Cyan
Write-Host "  scenarios : $Scenarios -> $OutDir   (est ~RMB $genCost)"
Write-Host "  distill   : $OutDir -> train\data\$SftOut   (est ~RMB $distCost)"
Write-Host "  train     : $ModelDir  (1 epoch ~ $([math]::Round($Scenarios * 2.4 / 16 * 105 / 3600, 1))h on RTX 5070 Laptop)"
Write-Host "  measured unit costs: generation RMB 0.011/call (cache hit ~63%), yield ~67% at a 32-80 message gate" -ForegroundColor DarkGray
Write-Host "                       distillation RMB 0.003/call (cache hit ~65%), ~2.4 pairs per scenario" -ForegroundColor DarkGray
if (-not $Yes) {
    Write-Host "`nDRY RUN. Add -Yes to spend about RMB $([math]::Round($genCost + $distCost, 1)) and actually run it." -ForegroundColor Yellow
    exit 0
}

if (-not $env:LLM_API_KEY -and -not (Select-String -Path .env -Pattern '^LLM_API_KEY=sk-' -Quiet)) {
    throw "No DeepSeek key found. Set `$env:LLM_API_KEY / `$env:LLM_BASE_URL / `$env:LLM_MODEL 'deepseek-chat' first."
}
if (-not $env:LLM_BASE_URL) { $env:LLM_BASE_URL = 'https://api.deepseek.com/v1' }
if (-not $env:LLM_MODEL) { $env:LLM_MODEL = 'deepseek-chat' }

Write-Host "`n=== [1/3] generate $Scenarios realism-aligned scenarios ===" -ForegroundColor Cyan
node train\dist\train\gen-scenarios.js --n $Scenarios --concurrency 3 --seed 20000 --out $OutDir
if ($LASTEXITCODE -ne 0) { throw "generation failed" }

Write-Host "`n=== [2/3] teacher distillation (same prompt builders as extract.ts) ===" -ForegroundColor Cyan
node train\dist\train\gen-sft-data.js --dir $OutDir --out $SftOut --max-candidates $MaxCandidates
if ($LASTEXITCODE -ne 0) { throw "distillation failed" }

if ($Train) {
    Write-Host "`n=== [3/3] QLoRA 1 epoch (checkpoint every 25 steps) ===" -ForegroundColor Cyan
    Write-Host "  NOTE: stop any local inference server first - 8GB VRAM cannot hold both." -ForegroundColor Yellow
    python train\extract\sft_qwen3.py --data (Join-Path $root "train\data\$SftOut") --drop-over-seq `
        --epochs $Epochs --seq 3072 --no-unsloth --save-steps 25 --out $ModelDir
    if ($LASTEXITCODE -ne 0) { throw "training failed" }
    Write-Host "`nAcceptance: powershell -File train\run_acceptance.ps1 -Model (Split-Path -Leaf $ModelDir)" -ForegroundColor Green
} else {
    Write-Host "`nData ready. Train with:" -ForegroundColor Green
    Write-Host "  python train\extract\sft_qwen3.py --data train\data\$SftOut --drop-over-seq --epochs 1 --seq 3072 --no-unsloth --save-steps 25 --out $ModelDir"
}
