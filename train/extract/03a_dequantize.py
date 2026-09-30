# -*- coding: utf-8 -*-
r"""bnb 4bit 合并模型 → 干净 bf16 权重（GGUF 转换前置）。

背景：QLoRA 训练后 merge_and_unload() 把 LoRA 合并进 4bit 权重并以 bnb 私有
格式保存（safetensors 含 U8 packed 权重 + absmax/nested_absmax）。转换器无法
映射这些张量。本脚本把每层 Linear4bit 反量化为 bf16 普通 Linear 后重新保存。

用法：
    $env:PYTHONPATH="$PWD\train\pylibs-gpu"
    python train\extract\03a_dequantize.py --src train\models\qwen3-1.7b-sft
"""
import argparse
import shutil
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def dequantize_model(in_dir: Path, out_dir: Path) -> None:
    import torch
    import bitsandbytes as bnb
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    print(f"加载 4bit 模型：{in_dir}")
    bnb_cfg = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype="bfloat16",
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        str(in_dir), quantization_config=bnb_cfg, device_map="cuda", torch_dtype="auto",
    )

    n_replaced = 0
    for name, module in list(model.named_modules()):
        if not isinstance(module, bnb.nn.Linear4bit):
            continue
        # 反量化：weight(uint8 packed) + quant_state → bf16 dense
        w = bnb.functional.dequantize_4bit(module.weight.data, module.quant_state).to(torch.bfloat16)
        assert w.shape == (module.out_features, module.in_features), f"{name}: {w.shape}"
        parent = model.get_submodule(".".join(name.split(".")[:-1]))
        leaf = name.split(".")[-1]
        new = torch.nn.Linear(module.in_features, module.out_features, bias=module.bias is not None, dtype=torch.bfloat16, device="cuda")
        new.weight.data = w
        setattr(parent, leaf, new)
        n_replaced += 1
    print(f"反量化 {n_replaced} 层 Linear4bit → bf16")
    assert n_replaced > 0, "没有发现 Linear4bit（可能已是干净权重）"

    # 逐参数转 bf16（绕开 transformers 对 bnb 模型 .to() 的限制——此时已无 4bit 层）
    for pname, p in model.named_parameters():
        p.data = p.data.to(torch.bfloat16)

    # 手动保存：绕开 transformers save_pretrained 的量化反操作（hf_quantizer 仍挂载会炸）
    from safetensors.torch import save_file

    out_dir.mkdir(parents=True, exist_ok=True)
    sd = model.state_dict()
    if getattr(model.config, "tie_word_embeddings", False):
        sd.pop("lm_head.weight", None)  # 与 embed_tokens 共享，GGUF 转换器按 tie 处理
    sd = {k: v.detach().to(torch.bfloat16).contiguous().cpu() for k, v in sd.items()}
    save_file(sd, str(out_dir / "model.safetensors"))
    cfg = model.config
    cfg.quantization_config = None
    try:
        cfg.dtype = "bfloat16"
    except Exception:  # noqa: BLE001
        pass
    cfg.use_cache = True
    cfg.save_pretrained(str(out_dir))
    tok = AutoTokenizer.from_pretrained(str(in_dir))
    tok.save_pretrained(str(out_dir))
    for extra in ("train-meta.json", "chat_template.jinja", "generation_config.json"):
        src = in_dir / extra
        if src.exists():
            shutil.copy2(src, out_dir / extra)
    mb = (out_dir / "model.safetensors").stat().st_size / 1e6
    print(f"✅ 干净 bf16 模型已存 {out_dir}（model.safetensors {mb:.0f}MB）")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=r"train\models\qwen3-1.7b-sft")
    args = ap.parse_args()
    src = Path(args.model)
    dequantize_model(src, src.parent / f"{src.name}-bf16")
