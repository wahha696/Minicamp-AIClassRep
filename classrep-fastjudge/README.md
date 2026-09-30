# ClassRep 本地快判脚手架（替代 Jev）

对齐：
- `Minicamp-AIClassRep/docs/本地快判/基座与标签-v1.md`
- `docs/scaffold-conventions-v1.md`
- 现网 `apps/server/src/pipeline/jev.ts`（见 `docs/jev-contract.md`）

**基座 v1：** `jieba` + `TfidfVectorizer` + `CalibratedClassifierCV(LogisticRegression)` → `models/local-jev-v1.joblib`  
**禁止：** torch / sentence-transformers / 本地 LLM。

## 目录

```
classrep-fastjudge/
  docs/           jev-contract · label-schema · acceptance-metrics · scaffold-conventions
  schemas/        sample.schema.json
  data/raw/       synth.jsonl mock.jsonl human.jsonl all.jsonl
  data/splits/    train.jsonl val.jsonl test.jsonl
  scripts/        synthesize.py convert_mock.py merge_and_split.py
  src/            features.py train.py evaluate.py infer.py
  models/         local-jev-v1.joblib
  reports/        metrics-v1.json split-stats.json
```

## 快速跑通

```bash
cd /workspace/classrep-fastjudge
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 1) mock 转换
python3 scripts/convert_mock.py

# 2) DeepSeek 合成（约 400–500 通路；可再 --target 5000）
eval "$(python3 /workspace/export_box_secrets.py)"
python3 scripts/synthesize.py --target 400

# 3) 合并 + 按 group_name 拆分（seed=20260928）
python3 scripts/merge_and_split.py

# 4) 训练（sklearn 一次 fit ≈ 线性模型的 1 epoch）
python3 src/train.py

# 5) 评测
python3 src/evaluate.py

# 6) 推理（对齐 scoreWithJev → number[]）
echo '{"group_name":"高数群","context":[],"candidates":[{"sender_name":"老师","text":"周五考试改到下周一"}]}' \
  | python3 src/infer.py
```

## 导出说明

v1 导出 **joblib**（约定路径 `models/local-jev-v1.joblib`）。ONNX 非本阶段必做；若 Node 侧要进程外推理，用 `src/infer.py` CLI。  
不提供 torch 权重导出。

## 标签

`label` ∈ {0,1}；可选 `soft_label`。详见 `docs/label-schema.md`。

## 接入 Minicamp-AIClassRep

见 `docs/integration-plan.md`。对比远端 Jev：

```bash
eval "$(python3 /workspace/export_box_secrets.py)"  # 可选；勿打印密钥
python3 scripts/compare_jev_local.py --holdout data/holdout/v2.jsonl
# → reports/compare-jev-local.json
```

Holdout 约定：`data/holdout/v2.jsonl`（schema：`schemas/holdout-v2.schema.json`）。
