# 双快判路线对齐说明（train/ ↔ classrep-fastjudge/）

> 本仓库当前存在**两条并行的"本地快判（Jev）"技术路线**，都能去掉 TypeSafe Key，
> 但实现与取舍不同。本文件说明差异、实测数据与推荐用法，避免队友误判/重复劳动。

## 两条路线

| 维度 | `classrep-fastjudge/`（队友脚手架） | `train/jev/`（本工作区） |
|---|---|---|
| 模型 | jieba + TF-IDF + Calibrated LR（sklearn） | rbt3（BERT-base 中文）微调 → ONNX INT8 |
| 产物 | `models/local-jev-v1.joblib`，**0.86MB** | `train/models/jev-classifier-onnx/model_quantized.onnx`，**36.9MB**（含 tokenizer） |
| 依赖 | 纯 Python（**明确约定不引入 torch**） | Python 训练侧 torch + 运行侧 `onnxruntime-node` |
| 单条延迟 | **≈2ms**（batch30 ≈14ms） | 30 条一批 **p50 ≈90–150ms**（CPU，功耗状态敏感） |
| 合成数据指标 | test `recall_pos@0.2 ≈0.85`，误杀 ≈0.15 | 合成 10k：AUC/PR-AUC/acc@0.5 = **1.0**（语料较易，非真实分布） |
| 接口形态 | Node 子进程调 `src/infer.py` | `onnxruntime-node` 进程内推理（见 `train/jev/INTEGRATION.md`） |

> 两者指标不可直接比较：快判脚手架的 0.85 写在**混合 mock+synth 的 750 条**上（mock 占 test 多数、且 mock 标签是启发式的）；本工作区的 1.0 写在**纯合成 10k**上。要横向比，必须跑同一 split。

## 推荐定位（**已用同口径实测修正，2026-09-30**）

**结论：不要用 rbt3-ONNX 替换 fastjudge，也不要拿它做级联第二级。**

在同一批 115 条候选、同一份参考标签上逐条对比（`train/.cache/head_to_head.py`，
标签取自 `jev-calibrate --dump` 的存档，两边输入同为 `群名 [SEP] prev [SEP] msg`）：

| 丢弃阈值 | fastjudge 召回 | fastjudge 丢弃率 | rbt3-ONNX 召回 | ONNX 丢弃率 |
|---|---|---|---|---|
| 0.05 | **92.0%** | 34.8% | 80.0% | 66.1% |
| 0.20 | **88.0%** | 47.0% | 68.0% | 77.4% |
| 0.45 | **88.0%** | 56.5% | 60.0% | 81.7% |

- **级联价值为 0**：ONNX 能救回、fastjudge 漏掉的真通知 = **0 条**；
  反过来 ONNX 会丢掉 fastjudge 保留的 **5 条**真通知（「老师说考到第四章第二节」「奖学金加分细则，会上要用」等）。
- 也就是说：本工作区的 36.9MB ONNX 在这份真实验收分布上**全面劣于**队友 4.9MB 的 TF-IDF 模型，
  且慢 1~2 个数量级（ONNX 单批 ~20ms vs fastjudge ~2ms/条）。
- 为什么？我的 Jev 训练数据是**纯合成**的（`gen-jev-data.ts`，10k 条 1:3），
  合成集上 AUC 1.0 没有迁移到真实分布——这正是手册反复强调"合成指标不等于真实表现"的实例。

### 因此当前建议

1. **默认继续用 fastjudge**（`FASTJUDGE_MODE=local`）；本工作区的 ONNX 不作为交付物上线路。
2. 若要把 ONNX 做成真能用的第二级，先补**真实分布标签**：
   按 `classrep-fastjudge/docs/HANDOFF-to-trainer.md` 的建议用 DeepSeek 对 `mock.jsonl`
   重打 label/soft_label，再用本工作区管道重训（`gen-jev-data.ts` → `02_train_rbt3.py` → `03_export_onnx.py`），
   然后**再用同一份 dump 跑一次 head_to_head**——没有这一步就别上线。
3. 快判的阈值问题（任何阈值都到不了 100% 召回）见
   `train/jev/INTEGRATION.md` §8：根因是"LLM event_sources 当召回基准"的口径，
   而不是模型不行；换模型不解决口径问题。

### 仍然可以复用的部分

- 验收门修复：`jev-calibrate.ts` 已能在 `FASTJUDGE_MODE=local`（无 TypeSafe key）下运行并 `--dump` 存档；
- 延迟经验：常驻 worker 冷启动 6.2s（默认超时 3s/下限 5s 会把首次请求判超时），p50 18ms；
- 训练/导出/量化管道本身可复用（换真实标签重训即可）。

## 不要做的事

- 不要把 `train/` 的 torch 依赖塞进 `classrep-fastjudge/`（脚手架明确约定不引入 torch；级联方案里 ONNX 只走 Node 侧 `onnxruntime-node`，不污染 Python 快判链路）。
- 不要用两条路线各自的指标互相"证明更好"——口径不同，必须同 split 复跑。

## 事件提取模型与本文件无关

`train/models/extract-v1-Q8_0.gguf`（Qwen3-1.7B QLoRA 蒸馏 → GGUF）是**另一个交付物**：
负责从群消息抽事件（`extract.ts` 的 LLM 角色），与快判（决定"要不要调 LLM"）是上下游关系，
不参与本文件讨论的选型。其验收口径见 `train/DELIVERABLES.md`。
