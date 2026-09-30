# -*- coding: utf-8 -*-
r"""校验交付用 GGUF 文件结构是否完好（CPU-only，不需要 GPU/llama.cpp）。

用法：python train\tools\verify_gguf.py train\models\extract-v1-Q8_0.gguf
"""
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import gguf  # pip install gguf（已随 train/pylibs-gpu）

for path in sys.argv[1:] or [r"train\models\extract-v1-Q8_0.gguf"]:
    try:
        r = gguf.GGUFReader(path)
    except Exception as e:  # noqa: BLE001
        print(f"❌ {path}: 读取失败 {type(e).__name__}: {e}")
        continue
    arch = "?"
    for f in r.fields.values():
        if f.name == "general.architecture":
            arch = bytes(f.parts[f.data[0]]).decode("utf-8", "replace")
    n_tensors = len(r.tensors)
    # 统计量化类型
    from collections import Counter

    kinds = Counter(str(t.tensor_type.name) for t in r.tensors)
    print(f"✅ {path}")
    print(f"   架构 {arch} | 张量 {n_tensors} 个 | 量化分布 {dict(kinds)}")
