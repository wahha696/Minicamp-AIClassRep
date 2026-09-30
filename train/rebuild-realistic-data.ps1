# Rebuild a REALISM-ALIGNED dataset and (optionally) train on it.
# ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8-no-BOM Chinese
# comments (a mojibake byte can be read as a line-continuation and swallow the
# next code line), so every comment here stays in ASCII.
#
# Why: the v1-v4 datasets were generated BEFORE the generator learned the real
# distribution (see train/BATCH-SHAPE.md). Measured after the fix:
#   chars/msg 5.0 vs real 5.9 | time-mentions 6.4% vs 6.0% | noise 72.5% vs 77.7%
#   candidates after BATCH=30 + isNoise: median 8 vs real 6
#
# NOTE on units: -Scenarios is the number of TEACHER CALLS, not usable scenarios.
# Measured yield is about 67% (message-count gate 32..80), so 800 calls -> ~536
# usable scenarios -> ~1,300 training pairs.
#
# Cost (measured on this machine, deepseek-chat):
#   generation  RMB 0.016 per call (cache hit ~64%; ~2,000 output tokens per call,
#               and OUTPUT dominates: ~92% of generation cost)
#   distillation RMB 0.0016 per pair
# Run with -Yes to actually spend money; otherwise it only prints the plan.
#
# Usage:
#   powershell -File train\rebuild-realistic-data.ps1 -Scenarios 800
#   powershell -File train\rebuild-realistic-data.ps1 -Scenarios 800 -Yes
#   powershell -File train\rebuild-realistic-data.ps1 -Scenarios 800 -Yes -Train
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

$usable = [math]::Round($Scenarios * 0.67)
$pairs = [math]::Round($Scenarios * 0.67 * 2.4)
$genCost = [math]::Round($Scenarios * 0.016, 1)
$distCost = [math]::Round($pairs * 0.0016, 1)
$trainHours = [math]::Round($pairs / 16 * 105 / 3600, 1)

Write-Host "=== plan ===" -ForegroundColor Cyan
Write-Host ("  generate  : {0} teacher calls -> ~{1} usable scenarios in {2}   (est ~RMB {3})" -f $Scenarios, $usable, $OutDir, $genCost)
Write-Host ("  distill   : -> train\data\{0}   (~{1} training pairs, est ~RMB {2})" -f $SftOut, $pairs, $distCost)
Write-Host ("  train     : {0}  (1 epoch ~ {1}h on RTX 5070 Laptop)" -f $ModelDir, $trainHours)
Write-Host "  measured units: generation RMB 0.016/call (cache hit ~64%, output-dominated), yield ~67% at a 32-80 message gate" -ForegroundColor DarkGray
Write-Host "                  distillation RMB 0.0016/pair (cache hit ~65%), ~2.4 pairs per usable scenario" -ForegroundColor DarkGray

if (-not $Yes) {
    Write-Host ("`nDRY RUN. Add -Yes to spend about RMB {0} and actually run it." -f [math]::Round($genCost + $distCost, 1)) -ForegroundColor Yellow
    exit 0
}

if (-not $env:LLM_API_KEY -and -not (Select-String -Path .env -Pattern '^LLM_API_KEY=sk-' -Quiet)) {
    throw "No DeepSeek key found. Set env LLM_API_KEY / LLM_BASE_URL / LLM_MODEL first."
}
if (-not $env:LLM_BASE_URL) { $env:LLM_BASE_URL = 'https://api.deepseek.com/v1' }
if (-not $env:LLM_MODEL) { $env:LLM_MODEL = 'deepseek-chat' }

Write-Host "`n=== [1/3] generate realism-aligned scenarios ===" -ForegroundColor Cyan
node train\dist\train\gen-scenarios.js --n $Scenarios --concurrency 3 --seed 20000 --out $OutDir
if ($LASTEXITCODE -ne 0) { throw "generation failed" }

Write-Host "`n=== [2/3] teacher distillation (same prompt builders as extract.ts) ===" -ForegroundColor Cyan
node train\dist\train\gen-sft-data.js --dir $OutDir --out $SftOut --max-candidates $MaxCandidates
if ($LASTEXITCODE -ne 0) { throw "distillation failed" }

if ($Train) {
    Write-Host "`n=== [3/3] QLoRA 1 epoch (checkpoint every 25 steps) ===" -ForegroundColor Cyan
    Write-Host "  NOTE: stop any local inference server first - 8GB VRAM cannot hold both." -ForegroundColor Yellow
    python train\extract\sft_qwen3.py --data (Join-Path $root "train\data\$SftOut") --drop-over-seq --epochs $Epochs --seq 3072 --no-unsloth --save-steps 25 --out $ModelDir
    if ($LASTEXITCODE -ne 0) { throw "training failed" }
    Write-Host ("`nAcceptance: powershell -File train\run_acceptance.ps1 -Model " + (Split-Path -Leaf $ModelDir)) -ForegroundColor Green
} else {
    Write-Host "`nData ready. Train with:" -ForegroundColor Green
    Write-Host "  python train\extract\sft_qwen3.py --data train\data\$SftOut --drop-over-seq --epochs 1 --seq 3072 --no-unsloth --save-steps 25 --out $ModelDir"
}
