# 交接说明 · 给模型训练员（2026-09-28 UTC+8）

产品经理脚手架已按 `scaffold-conventions-v1.md` + `基座与标签-v1.md` 落齐并跑通通路。

## 已落盘（勿改口径）

| 路径 | 说明 |
|------|------|
| `docs/jev-contract.md` | 与 `apps/server/src/pipeline/jev.ts` / `scheduler.ts` / `filter.ts` 对齐 |
| `docs/label-schema.md` + `schemas/sample.schema.json` | label 0/1 + soft_label |
| `docs/acceptance-metrics.md` | 召回@0.2 / 误杀 / 误报 / 延迟 / 包体 |
| `docs/scaffold-conventions-v1.md` | 路径与 group_name 拆分 |
| `scripts/convert_mock.py` | mock→`data/raw/mock.jsonl` |
| `scripts/synthesize.py` | DeepSeek 合成→`data/raw/synth.jsonl` |
| `scripts/merge_and_split.py` | seed=20260928，按群拆分 |
| `src/{features,train,evaluate,infer}.py` | jieba+TF-IDF+Calibrated LR，joblib |
| `models/local-jev-v1.joblib` | 已 fit 一次（≈1 epoch） |
| `reports/metrics-v1.json` / `split-stats.json` | 指标 |

仓库软链：`Minicamp-AIClassRep/docs/本地快判/{jev-contract,label-schema,acceptance-metrics,scaffold-conventions-v1}.md`

## 样本规模（当前通路批）

- synth：**365**（pos 202 / neg 163）— 目标可扩到 5k：`python3 scripts/synthesize.py --target 5000 --append`
- mock：**385**（启发式标签 pos 仅 27 — **偏保守，需教师重标**）
- all：**750** → train 295 / val 103 / test 352（mock 多数在 test）

## 通路结果摘要

- fit：0.59s；模型 **0.86 MB**
- test `recall_pos@0.2` ≈ **0.85**（误杀≈0.15）；负例丢弃@0.2 仍偏低
- 延迟 ≈ **2 ms/条**，batch30 ≈ 14 ms
- infer 烟测：改期通知 ~0.98；「哈哈哈收到」~0.03；「晚上约饭吗」~0.01

## 建议下一步

1. 用 DeepSeek 对 `mock.jsonl` 重打 `label`/`soft_label`（替换 `notes=heuristic_v1`），提高正例覆盖（改期/取消/短变更）。
2. 合成扩到 **5k**，压负例比例至约 1:2～1:3；过滤自相矛盾 soft/hard。
3. 调 `C` / `max_features` / isotonic；可并联 KEEP_WORD/时间正则抬升召回@0.2。
4. 验收以误杀优先；达标后再接 Node 子进程调用 `src/infer.py`。
5. **不要**引入 torch / sentence-transformers。

密钥：`eval "$(python3 /workspace/export_box_secrets.py)"`，勿打印 Key。
