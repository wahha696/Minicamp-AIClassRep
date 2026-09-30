# Local training env setup (Windows native route; Windows edition of manual section 1).
# Usage (repo root, PowerShell):
#   powershell -ExecutionPolicy Bypass -File train\env\setup_windows.ps1
#
# Everything installs into train\pylibs-gpu (--target mode, no venv bootstrap needed).
# Principle: RTX 50-series (Blackwell) REQUIRES cu128 torch (manual 1.1: older builds
# fail with "no kernel image for sm_120").

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot | Split-Path -Parent   # repo root
$PY = "python"

Write-Host "== 1. Python version check (manual prefers 3.12; 3.13 needs a 2026-era stack)"
& $PY --version
$pyv = & $PY -c "import sys; print(str(sys.version_info.major) + '.' + str(sys.version_info.minor))"
if (@("3.11", "3.12", "3.13") -notcontains $pyv) {
    throw "Need Python 3.11/3.12/3.13, got $pyv"
}
if ($pyv -eq "3.13") {
    Write-Host "WARN Python 3.13: if unsloth fails to install, open a 3.12 env with uv:"
    Write-Host "  uv venv train\.venv312 --python 3.12"
}

$env:TMP = Join-Path $ROOT "train\.cache\temp"
$env:TEMP = $env:TMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$PIPArgs = @("--disable-pip-version-check", "--cache-dir", "$ROOT\train\.cache\pip")

Write-Host "== 2. torch cu128 (Blackwell mandatory; older builds die with 'no kernel image for sm_120')"
& $PY -m pip install @PIPArgs --target "$ROOT\train\pylibs-gpu" torch --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw "torch cu128 install failed" }

Write-Host "== 3. training stack (transformers / trl / peft / datasets / unsloth / onnxruntime)"
& $PY -m pip install @PIPArgs --target "$ROOT\train\pylibs-gpu" transformers datasets accelerate peft trl bitsandbytes optimum onnxruntime scikit-learn
if ($LASTEXITCODE -ne 0) { throw "training stack install failed" }
& $PY -m pip install @PIPArgs --target "$ROOT\train\pylibs-gpu" unsloth
Write-Host "(unsloth failing on native Windows is a known limitation; fall back to LLaMA-Factory or WSL2 - see train/README)"

Write-Host "== 4. GPU smoke (manual section 1.3 prerequisite)"
$env:PYTHONPATH = "$ROOT\train\pylibs-gpu"
& $PY "$ROOT\train\env\smoke_gpu.py"
Write-Host "== Done. Run training with PYTHONPATH=train\pylibs-gpu (see train/README)"
