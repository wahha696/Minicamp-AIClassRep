# Acceptance driver: dequantize -> GGUF -> local server -> eval.ts
# ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8-no-BOM Chinese.
#
# Usage:
#   powershell -File train\run_acceptance.ps1                       # default v2 model
#   powershell -File train\run_acceptance.ps1 -Model qwen3-1.7b-sft # v1 model
#   powershell -File train\run_acceptance.ps1 -SkipTrain           # only export + eval
param(
    [string]$Model = "qwen3-1.7b-sft-v2",
    [int]$Port = 8080,
    [switch]$SkipGguf,
    [switch]$Week
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONPATH = Join-Path $root "train\pylibs-gpu"
$env:NO_LOCAL_GGUF = "1"

$src = Join-Path $root "train\models\$Model"
$bf16 = "$src-bf16"

Write-Host "=== [1/4] bnb 4bit -> clean bf16: $Model" -ForegroundColor Cyan
if (Test-Path $bf16) {
    Write-Host "  already exists: $bf16 (delete it to redo)"
} else {
    python train\extract\03a_dequantize.py --model $src
    if ($LASTEXITCODE -ne 0) { throw "dequantize failed" }
}

if (-not $SkipGguf) {
    Write-Host "=== [2/4] export GGUF Q8_0" -ForegroundColor Cyan
    python train\extract\03_export_gguf.py --model $bf16 --quant Q8_0 --skip-f16
    if ($LASTEXITCODE -ne 0) { throw "gguf export failed" }
} else {
    Write-Host "=== [2/4] GGUF export skipped" -ForegroundColor DarkGray
}

Write-Host "=== [3/4] start local OpenAI-compatible server on port $Port" -ForegroundColor Cyan
Write-Host "  NOTE: stop any training first - 8GB VRAM cannot hold both." -ForegroundColor Yellow
$srv = Start-Process -FilePath "python" -ArgumentList @(
    "train\env\serve_hf.py", "--model", $bf16, "--port", "$Port"
) -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 45
try {
    $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 20
    Write-Host "  server up: $($probe.data[0].id)"
} catch {
    Write-Host "  server probe failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "=== [4/4] eval.ts (zero-code acceptance via .env)" -ForegroundColor Cyan
Write-Host "  .env must be: LLM_BASE_URL=http://127.0.0.1:$Port/v1  LLM_API_KEY=local  LLM_MODEL=extract"
$evalArgs = @("--filter", "server", "exec", "tsx", "src/pipeline/eval.ts")
if ($Week) { $evalArgs += "--week" }
& pnpm.cmd @evalArgs
$code = $LASTEXITCODE

Write-Host "=== stopping server (pid $($srv.Id))" -ForegroundColor DarkGray
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue

if ($code -eq 0) {
    Write-Host "ACCEPTANCE PASSED" -ForegroundColor Green
} else {
    Write-Host "ACCEPTANCE FAILED (exit $code) - see failure detail above" -ForegroundColor Yellow
}
exit $code
