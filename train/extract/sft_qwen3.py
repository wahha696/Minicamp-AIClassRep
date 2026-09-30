# -*- coding: utf-8 -*-
"""事件提取模型 QLoRA SFT：Qwen3-1.7B（操作手册 §4，RTX 5070 Laptop 8GB）。

  python train/extract/02_sft_qwen3.py                        # 默认 1.7B + seq 4096 + 3 epoch
  python train/extract/extract_sft.py --seq 2048 --rank 16    # OOM 阶梯第 1~2 级
  python train/extract/sft_qwen3.py --limit 100 --epochs 1    # 冒烟（先冒烟再全量，手册 §1.3）

数据：train/data/sft-v1.jsonl（gen-sft-data.js 产出，sharegpt 格式）。
铁律（手册 §2.2）：样本 meta.prompt_version 必须等于 extract.ts 的 PROMPT_VERSION，不一致直接退出——
prompt 对不上 = 白训。

OOM 阶梯（按序降）：
  1) --seq 2048（配套砍训练样本上下文，绝不砍 system 规则段）
  2) --rank 16 → 8
  3) --grad-accum 32（等效 batch 不变）
  4) 还不行 → 换 --base unsloth/Qwen3-0.6B 先验证管线
"""
from __future__ import annotations

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK console guard
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_sft(path: Path, limit: int) -> list[dict]:
    """读 sharegpt JSONL → [{system, user, assistant}]；prompt_version 不对就退出。"""
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if not t:
                continue
            obj = json.loads(t)
            conv = {c["from"]: c["value"] for c in obj["conversations"]}
            meta = obj.get("meta", {}) or {}
            pv = meta.get("prompt_version")
            if pv is None:
                raise SystemExit("数据缺 meta.prompt_version（老格式数据）：请用最新 gen-sft-data.js 重新导出")
            if int(pv) != EXPECTED_PROMPT_VERSION:
                raise SystemExit(
                    f"prompt_version 不匹配：数据 pv={pv}，生产 PROMPT_VERSION={EXPECTED_PROMPT_VERSION}。"
                    "prompt 变过 = 旧数据作废，重新生成数据后再训（操作手册 §2.2 铁律）。"
                )
            rows.append({
                "system": conv["system"],
                "user": conv["human"],
                "assistant": conv["gpt"],
                "scenario": meta.get("scenario", ""),
                "est_tokens": meta.get("est_tokens", 0),
            })
    if limit > 0:
        rows = rows[:limit]
    return rows


# PROMPT_VERSION 由数据管道烙进 meta；这里只做一致性闸门（与 lib/prompts.ts 同步维护）
EXPECTED_PROMPT_VERSION = 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="unsloth/Qwen3-1.7B")
    ap.add_argument("--data", default=str(HERE.parent / "data" / "sft-v1.jsonl"))
    ap.add_argument("--out", default=str(HERE.parent / "models" / "qwen3-1.7b-sft"))
    ap.add_argument("--seq", type=int, default=4096, help="1.7B@8GB 上限；OOM 降 2048")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=32, help="OOM 阶梯：32→16→8")
    ap.add_argument("--alpha", type=int, default=0, help="默认 rank*2（r32/α64）")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="只用前 N 条（冒烟）")
    ap.add_argument("--drop-over-seq", action="store_true", help="丢弃 est_tokens > seq 的样本（防截断 assistant JSON）")
    ap.add_argument("--resume", action="store_true", help="从 output_dir 最近的 checkpoint 续训（中断后接着跑）")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--save-steps", type=int, default=500)
    ap.add_argument("--no-unsloth", action="store_true", help="跳过 unsloth，用标准 transformers+peft（bs 仍为 1×ga16）")
    args = ap.parse_args()

    import os

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")  # 国内网络走镜像

    data = load_sft(Path(args.data), args.limit)
    if args.drop_over_seq:
        before = len(data)
        data = [r for r in data if r["est_tokens"] <= args.seq]
        print(f"按 seq {args.seq} 过滤超长样本：{before} → {len(data)}（丢弃 {before - len(data)} 条，避免截断 assistant JSON 尾部）")
    toks = sum(r["est_tokens"] for r in data)
    print(f"样本 {len(data)}，≈{toks // 1000}k tok（平均 {toks // max(1, len(data))} tok/条）")
    too_long = sum(1 for r in data if r["est_tokens"] > args.seq)
    if too_long > 0:
        print(f"⚠ {too_long} 条样本超 seq {args.seq}：训练时会被截断。建议重跑 gen-sft-data.js --max-candidates 15 缩批")

    # ---- 模型与 LoRA（手册 §4.1 配置）；unsloth 不可用时走标准 transformers+peft ----
    use_unsloth = not args.no_unsloth
    if use_unsloth:
        try:
            from unsloth import FastLanguageModel
        except Exception as e:  # noqa: BLE001 — unsloth 与新版 transformers 不兼容时自动回退
            print(f"unsloth 不可用（{type(e).__name__}: {e}），回退标准 transformers+peft 路线")
            use_unsloth = False

    if use_unsloth:
        model, tok = FastLanguageModel.from_pretrained(
            model_name=args.base,
            max_seq_length=args.seq,
            load_in_4bit=True,
        )
        model = FastLanguageModel.get_peft_model(
            model,
            r=args.rank,
            lora_alpha=args.alpha if args.alpha > 0 else args.rank * 2,
            lora_dropout=0,
            bias="none",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            use_gradient_checkpointing="unsloth",
            random_state=args.seed,
        )
    else:
        # 标准路径：bitsandbytes 4bit + peft（无 unsloth 依赖，内存略高但 8GB 可跑）
        import torch
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        tok = AutoTokenizer.from_pretrained(args.base)
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        try:
            model = AutoModelForCausalLM.from_pretrained(
                args.base, quantization_config=bnb, device_map="auto", torch_dtype="auto",
            )
        except Exception as e:  # bnb 对 sm_120 不支持时退 bf16 全量 LoRA（8GB 勉强，seq 降 2048）
            print(f"bitsandbytes 4bit 失败（{e}）→ 回退 bf16 LoRA（无量化）")
            model = AutoModelForCausalLM.from_pretrained(
                args.base, torch_dtype="auto", device_map="auto", attn_implementation="sdpa",
            )
            quant_note = "bf16"
        else:
            quant_note = "4bit(bnb)"
            model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
        model = get_peft_model(model, LoraConfig(
            r=args.rank,
            lora_alpha=args.alpha if args.alpha > 0 else args.rank * 2,
            lora_dropout=0,
            bias="none",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            task_type="CAUSAL_LM",
        ))
        print(f"LoRA r={args.rank} α={args.alpha or args.rank * 2}，seq={args.seq}，量化={quant_note}")

    # ---- 数据：预分词 torch Dataset（绕开 datasets 5.x 指纹 bug），labels 只算 assistant 段 ----
    import torch

    def encode_pair(r: dict) -> tuple[list[int], list[int]]:
        """返回 (input_ids, labels)；labels 仅 assistant 段非 -100（completion-only）。

        前缀严格对齐（Qwen3 空 think 块坑）：prompt 侧用 add_generation_prompt=True +
        enable_thinking=False，模板会在 assistant 标记后插 `∥think\n\n∥` 空思考块。
        若 full 侧用 3 消息模板（assistant 直接接内容），两条路径在 assistant 处分叉，
        掩码会盖掉 JSON 开头几个 token（模型学不会输出开头 → 推理时带 ```json 围栏）。
        正解：prompt_ids（含空 think 块）token 级拼接 assistant 内容，天然严格前缀对齐。
        """
        prompt_text = tok.apply_chat_template(
            [
                {"role": "system", "content": r["system"]},
                {"role": "user", "content": r["user"]},
            ],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,  # 与推理 serve_hf.py / extract.ts 完全同构
        )
        prompt_ids = tok(prompt_text, add_special_tokens=False)["input_ids"]
        asst_ids = tok(r["assistant"], add_special_tokens=False)["input_ids"]
        eot = tok.convert_tokens_to_ids("<|im_end|>")
        full_ids = (prompt_ids + asst_ids + [eot])[: args.seq]
        labels = ([-100] * len(prompt_ids) + asst_ids + [eot])[: len(full_ids)]
        return full_ids, labels

    class SftRows(torch.utils.data.Dataset):
        """预分词原生数据集（Windows spawn 友好，无 datasets 依赖）"""

        def __init__(self, rows: list[dict]):
            self.items: list[dict] = []
            for r in rows:
                ids, labels = encode_pair(r)
                self.items.append({"input_ids": ids, "labels": labels})

        def __len__(self) -> int:
            return len(self.items)

        def __getitem__(self, i: int) -> dict:
            return self.items[i]

    def collate(batch: list[dict]) -> dict:
        pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
        maxlen = max(len(x["input_ids"]) for x in batch)
        ids = torch.full((len(batch), maxlen), pad, dtype=torch.long)
        lab = torch.full((len(batch), maxlen), -100, dtype=torch.long)
        att = torch.zeros((len(batch), maxlen), dtype=torch.long)
        for i, x in enumerate(batch):
            n = len(x["input_ids"])
            ids[i, : n] = torch.tensor(x["input_ids"], dtype=torch.long)
            lab[i, : n] = torch.tensor(x["labels"], dtype=torch.long)
            att[i, : n] = 1
        return {"input_ids": ids, "attention_mask": att, "labels": lab}

    from transformers import Trainer, TrainingArguments

    total_steps = max(1, int(len(data) * args.epochs / (args.batch * args.grad_accum)))
    # 每轮训练独立存档目录（用 --out 的名字）：多轮实验的 checkpoint 不能互相污染，
    # 否则 --resume 会接到上一次实验的存档上（数据不同 → 静默跑错）。
    run_dir = HERE.parent / "artifacts" / f"sft-runs-{Path(args.out).name}"
    conf = TrainingArguments(
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=max(5, int(total_steps * 0.06)),  # ≈6% 步数；v5 移除了 warmup_ratio
        weight_decay=0.01,
        bf16=True,
        gradient_checkpointing=True,
        logging_steps=10,
        save_steps=args.save_steps,
        save_total_limit=2,
        report_to=[],
        seed=args.seed,
        output_dir=str(run_dir),
        dataloader_num_workers=0,  # Windows spawn 不支持嵌套类；预分词数据主进程加载无瓶颈
        gradient_checkpointing_kwargs={"use_reentrant": False},
    )
    trainer = Trainer(model=model, args=conf, train_dataset=SftRows(data), data_collator=collate)

    # 断点续训（--resume）：机器休眠/会话重启会杀进程，8 小时训练不能白丢。
    # 注意：目录里没有 checkpoint-N 时不能让 Trainer 收到 resume=True（它会直接抛错），
    # 所以这里先探测再决定，并把实际行为打印出来，避免"以为在续训、其实从头跑"。
    ckpts = sorted(
        (p for p in run_dir.glob("checkpoint-*") if p.is_dir()),
        key=lambda p: int(p.name.split("-")[-1]) if p.name.split("-")[-1].isdigit() else -1,
    ) if run_dir.exists() else []
    resume = None
    if args.resume:
        if ckpts:
            resume = True
            print(f"--resume：从 {ckpts[-1].name} 续训（共 {len(ckpts)} 个检查点）")
        else:
            print(f"--resume：{run_dir} 下没有 checkpoint-*，改为从头训练")
    trainer.train(resume_from_checkpoint=resume)

    # 合并导出（16bit，供 GGUF 转换；见 03_export_gguf.py）
    out = Path(args.out)
    merged = model.merge_and_unload() if not use_unsloth else model
    merged.save_pretrained(str(out))
    tok.save_pretrained(str(out))
    (out / "train-meta.json").write_text(
        json.dumps({
            "base": args.base,
            "data": args.data,
            "prompt_version": EXPECTED_PROMPT_VERSION,
            "seq": args.seq,
            "epochs": args.epochs,
            "lr": args.lr,
            "rank": args.rank,
            "alpha": args.alpha or args.rank * 2,
            "grad_accum": args.grad_accum,
            "n_samples": len(data),
        }, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"\n✅ 合并模型已存 {out}（下一步：03_export_gguf.py 转 GGUF Q4_K_M）")


if __name__ == "__main__":
    main()
