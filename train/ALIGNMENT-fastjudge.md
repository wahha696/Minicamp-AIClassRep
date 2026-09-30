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

## 推荐定位（互补，不是二选一）

1. **默认走快判脚手架**：2ms、0.86MB、无 torch —— 作为每批候选的第一道闸门，成本几乎为零。
2. **不确定样本走 ONNX 模型**（级联第二级）：把 fastjudge 分数落在中间区间（如 0.2–0.7）的候选交给 rbt3-ONNX 复判，用更强的语义能力兜住难例。级联只在少数候选上付出 ~100ms/30 条的代价。
3. **横向评测方法**（要选型就先做这一步）：用 `classrep-fastjudge/scripts/merge_and_split.py` 的同一 split，分别跑两条路线的 `recall_pos@0.2` / 误杀 / 误报 / 延迟 / 包体，把结果并排写进 `acceptance-metrics` 口径的表格，再决定是否保留级联。

## 不要做的事

- 不要把 `train/` 的 torch 依赖塞进 `classrep-fastjudge/`（脚手架明确约定不引入 torch；级联方案里 ONNX 只走 Node 侧 `onnxruntime-node`，不污染 Python 快判链路）。
- 不要用两条路线各自的指标互相"证明更好"——口径不同，必须同 split 复跑。

## 事件提取模型与本文件无关

`train/models/extract-v1-Q8_0.gguf`（Qwen3-1.7B QLoRA 蒸馏 → GGUF）是**另一个交付物**：
负责从群消息抽事件（`extract.ts` 的 LLM 角色），与快判（决定"要不要调 LLM"）是上下游关系，
不参与本文件讨论的选型。其验收口径见 `train/DELIVERABLES.md`。
