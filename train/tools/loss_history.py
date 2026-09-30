# -*- coding: utf-8 -*-
r"""从 checkpoint 的 trainer_state.json 读 loss 轨迹（PowerShell 会吞掉 stdout 日志时用）。"""
import glob
import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

pattern = sys.argv[1] if len(sys.argv) > 1 else "train/artifacts/sft-runs-qwen3-1.7b-sft-real/*/trainer_state.json"
files = sorted(glob.glob(pattern))
if not files:
    print("没有 trainer_state.json（检查点还没落盘）")
    sys.exit(0)

for p in files:
    d = json.load(open(p, encoding="utf-8"))
    hist = [x for x in d.get("log_history", []) if "loss" in x]
    print(f"{p}: {len(hist)} 条 loss 记录，global_step={d.get('global_step')}")
    for x in hist:
        print(f"  step {x.get('step'):>3} | loss {x.get('loss'):.4f} | lr {x.get('learning_rate'):.2e} | epoch {x.get('epoch'):.2f}")
