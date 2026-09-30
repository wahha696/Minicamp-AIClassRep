# -*- coding: utf-8 -*-
"""合并模型 → GGUF（操作手册 §5）：convert_hf_to_gguf + llama-quantize Q4_K_M。

  python train/extract/03_export_gguf.py --model train/models/qwen3-1.7b-sft
  python train/extract/03_export_gguf.py --model train/models/qwen3-1.7b-sft --f16-only   # 先只出 f16

前置：clone llama.cpp（CPU 即可，不用编译 CUDA）：
  git clone https://github.com/ggml-org/llama.cpp train/llama.cpp
产出：train/models/extract-Q4_K_M.gguf（~1.1GB 交付物）+ extract-f16.gguf（迭代用中间产物）
"""
from __future__ import annotations

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK console guard
import argparse
import json
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(cmd: list[str]) -> None:
    print("+", " ".join(str(x) for x in cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise SystemExit(f"命令失败：{' '.join(map(str, cmd))}（exit {r.returncode}）")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(HERE.parent / "models" / "qwen3-1.7b-sft"))
    ap.add_argument("--llama-cpp", default=str(HERE.parent / "llama.cpp"), help="llama.cpp 仓库目录")
    ap.add_argument("--out", default=str(HERE.parent / "models"), help="GGUF 输出目录")
    ap.add_argument("--name", default="extract")
    ap.add_argument("--quant", default="Q4_K_M")
    ap.add_argument("--skip-f16", action="store_true", help="跳过 f16 转换（重跑量化时用）")
    args = ap.parse_args()

    src = Path(args.model)
    lc = Path(args.llama_cpp)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    convert = lc / "convert_hf_to_gguf.py"
    if not convert.exists():
        raise SystemExit(
            f"没有 {convert}：先 clone llama.cpp（CPU 即可）\n"
            "  git clone https://github.com/ggml-org/llama.cpp train/llama.cpp"
        )

    f16 = out_dir / f"{args.name}-f16.gguf"
    if not args.skip_f16:
        run(["python", str(convert), str(src), "--outfile", str(f16)])
    if not f16.exists() and not args.quant.upper() == "Q8_0":
        raise SystemExit(f"没有 {f16}：先跑 f16 转换（去掉 --skip-f16）")
    if f16.exists():
        print(f"f16 GGUF：{f16.stat().st_size / 1e9:.2f}GB")

    qfile = out_dir / f"{args.name}-{args.quant}.gguf"
    quantize_bin = lc / "build" / "bin" / ("llama-quantize.exe" if os.name == "nt" else "llama-quantize")
    if not quantize_bin.exists():
        quantize_bin = lc / ("llama-quantize.exe" if os.name == "nt" else "llama-quantize")

    if quantize_bin.exists():
        # 标准路径：f16 → llama-quantize（Q4_K_M ~1.1GB）
        run([str(quantize_bin), str(f16), str(qfile), args.quant])
    elif args.quant.upper() == "Q8_0":
        # 墙内替代：转换器原生支持 q8_0（无需量化二进制），1.7B ≈ 1.9GB，精度优于 Q4_K_M
        print("没有 llama-quantize 二进制 → 用转换器直出 Q8_0（体积略大，质量更高）")
        run(["python", str(convert), str(src), "--outfile", str(qfile), "--outtype", "q8_0"])
    else:
        raise SystemExit(
            f"没有 {quantize_bin}：K 量化需要 llama.cpp 的 llama-quantize 二进制。\n"
            "替代方案：--quant Q8_0（转换器直接出，无需二进制）；或下载 llama.cpp Release 放 build/bin/"
        )
    q_mb = qfile.stat().st_size / 1e6

    meta_file = src / "train-meta.json"
    meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {"base": str(src)}
    meta["gguf"] = {
        "file": str(qfile),
        "quant": args.quant,
        "size_mb": round(qfile.stat().st_size / 1e6, 1),
        "smoke": f"llama-server -m {qfile} --port 8080 --ctx-size 8192 --jinja",
    }
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"✅ {qfile}（{q_mb:.0f}MB）—— 接 llama-server 零代码验收（见 train/README）")


if __name__ == "__main__":
    main()
