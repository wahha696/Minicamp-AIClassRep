# Local llama-server helper for zero-code acceptance (train/README section 5).
# Usage:
#   powershell -ExecutionPolicy Bypass -File train\env\llama-server.ps1              # start with extract-Q4_K_M
#   powershell ... -File train\env\llama-server.ps1 -Gguf train\models\extract-f16.gguf
#
# After it is up, set .env (repo root) to:
#   LLM_BASE_URL=http://127.0.0.1:8080/v1
#   LLM_API_KEY=local
#   LLM_MODEL=extract
# then run: pnpm --filter server exec tsx src/pipeline/eval.ts --week

param(
    [string]$Gguf = "",
    [int]$Port = 8080,
    [int]$Ctx = 8192,
    [int]$Threads = 0   # 0 = auto
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot | Split-Path -Parent   # repo root

if ($Gguf -eq "") {
    $Gguf = Join-Path $ROOT "train\models\extract-Q4_K_M.gguf"
}
if (-not (Test-Path $Gguf)) {
    Write-Host "GGUF not found: $Gguf"
    Write-Host "Train first: python train\extract\sft_qwen3.py && python train\extract\03_export_gguf.py"
    exit 2
}

$server = Get-ChildItem -Path "$ROOT\train\llama.cpp" -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $server) {
    throw "llama-server.exe not found under train\llama.cpp - build it or download a release (see train/README)"
}

Write-Host "Starting llama-server on http://127.0.0.1:8080 (ctx $Ctx)"
Write-Host "GGUF: $Gguf"
& $server.FullName -m $Gguf --port $Port -c $Ctx --jinja
