# -*- coding: utf-8 -*-
"""GPU 环境冒烟（操作手册 §1.3）：半分钟确认 5070 训练栈可用。

  python train/env/smoke_gpu.py

期望：CUDA 可用、capability (12, 0)、bf16 matmul 正常、显存余量报告。
"""
from __future__ import annotations

import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK 控制台兜底

import torch

print(f"torch {__import__('torch').__version__}")
if not torch.cuda.is_available():
    raise SystemExit("❌ CUDA 不可用：检查驱动 / 是否装了 cu128 版 torch（50 系装旧版会 no kernel image for sm_120）")

name = torch.cuda.get_device_name(0)
cap = torch.cuda.get_device_capability()
total = torch.cuda.get_device_properties(0).total_memory / 2**30
free = torch.cuda.mem_get_info()[0] / 2**30
print(f"GPU：{name}  capability={tuple(torch.cuda.get_device_capability())}  显存 {total:.1f}GB（空闲 {free:.1f}GB）")

if tuple(torch.cuda.get_device_capability()) < (12, 0):
    print("⚠ capability 不是 (12, 0)：本机应为 50 系 Blackwell (12,0)。若是旧值说明 torch 不是 cu128 包")

x = torch.randn(4096, 4096, device="cuda", dtype=torch.bfloat16)
torch.cuda.synchronize()
t0 = time.perf_counter()
for _ in range(20):
    y = x @ x
torch.cuda.synchronize()
ms = (time.perf_counter() - t0) * 1000 / 10
print(f"bf16 matmul 4096²: {ms:.1f}ms（有数值即 OK）")
alloc = torch.cuda.max_memory_allocated() / 2**30
print(f"显存峰值 {alloc:.2f}GB / {total:.1f}GB")
print(f"\n✅ GPU 冒烟通过（{name}）—— 可以开始 unsloth QLoRA 训练")
