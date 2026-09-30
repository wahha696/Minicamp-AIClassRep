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
    [switch]$Week,
    # Also run a second eval pass with the code-side date normalizer enabled
    # (eval.ts --dates) so the report shows both arms from the same model output.
    [switch]$Dates
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
# Server stdout/stderr go to files: without this, a load failure is invisible
# (the process dies in its own console) and the eval ends as a deceptive llm=error 0/6.
# Measured 2026-09-30: exactly that happened, and the false negative looked like a model failure.
$srvOut = Join-Path $root "train\artifacts\server-$Model.log"
$srvErr = Join-Path $root "train\artifacts\server-$Model.err"
$srv = Start-Process -FilePath "python" -ArgumentList @(
    "train\env\serve_hf.py", "--model", $bf16, "--port", "$Port"
) -PassThru -WindowStyle Hidden -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr
Write-Host "  server logs: $srvOut / $srvErr" -ForegroundColor DarkGray
# bf16 3.4GB load + torch import measured 20~70s; probe with retries instead of one fixed sleep,
# and fail loudly if the server never comes up (a connection error must not be graded as 0/6).
$up = $false
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 10
    if ($srv.HasExited) {
        Write-Host "  server exited early (code $($srv.ExitCode)) - see $srvErr" -ForegroundColor Red
        break
    }
    try {
        $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 10
        Write-Host "  server up after $($i * 10)s: $($probe.data[0].id)" -ForegroundColor Green
        $up = $true
        break
    } catch { }
}
if (-not $up) {
    Write-Host "  SERVER NEVER CAME UP - aborting before eval (a connection failure is not a model result)" -ForegroundColor Red
    Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
    exit 3
}

Write-Host "=== [4/4] eval.ts (zero-code acceptance via .env)" -ForegroundColor Cyan
Write-Host "  .env must be: LLM_BASE_URL=http://127.0.0.1:$Port/v1  LLM_API_KEY=local  LLM_MODEL=extract"
$evalArgs = @("--filter", "server", "exec", "tsx", "src/pipeline/eval.ts")
if ($Week) { $evalArgs += "--week" }
& pnpm.cmd @evalArgs
$code = $LASTEXITCODE

if ($Dates) {
    Write-Host "=== [4b/4] eval.ts --dates (same model output, code-side date normalization on)" -ForegroundColor Cyan
    $evalArgs2 = @("--filter", "server", "exec", "tsx", "src/pipeline/eval.ts", "--dates")
    if ($Week) { $evalArgs2 += "--week" }
    & pnpm.cmd @evalArgs2
    Write-Host "  (dates arm exit $LASTEXITCODE - reported for comparison, not part of the pass/fail gate)" -ForegroundColor DarkGray
}

Write-Host "=== stopping server (pid $($srv.Id))" -ForegroundColor DarkGray
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue

if ($code -eq 0) {
    Write-Host "ACCEPTANCE PASSED" -ForegroundColor Green
} else {
    Write-Host "ACCEPTANCE FAILED (exit $code) - see failure detail above" -ForegroundColor Yellow
}
exit $code
