# Jev 本地分类器接入说明（M1 集成交接）

> 训练产物：`train/models/jev-classifier-onnx/model_quantized.onnx`（INT8 ~40MB）+ 同目录 `tokenizer/`。
> 目标：`apps/server/src/pipeline/jev.ts` 内的 `scoreWithJev()` 从 TypeSafe 远端换成本地 ONNX 推理，
> **TypeSafe key 从项目里消失**（操作手册 §3 的独立成果），调用方零改动。

## 1. 依赖

```bash
pnpm --filter server add onnxruntime-node  # MIT，MIT 许可，纯本地推理
```

把训练产物拷进运行时分发目录（M2 的 fetch-model 链路负责下载，开发期直接复制）：

```
app/models/jev-classifier.onnx        ← model_quantized.onnx
app/models/jev-tokenizer/             ← tokenizer.json 等 5 个文件
```

## 2. 输入构造（必须与训练数据一致）

训练样本文本形态（见 `train/gen-jev-data.ts`）：

```
群名 [SEP] 上一条消息 [SEP] 本条消息     ← 有上一条
群名 [SEP] [SEP] 本条消息               ← 没有上一条
```

对应 `jev.ts` 的 `state`：`group_name` / `previous_messages`（最后一条）/ `messages[i]`。

## 3. 参考实现（替换 scoreWithJev 内部，签名不变）

```ts
import * as ort from 'onnxruntime-node';
import { getTokenizer } from '@huggingface/transformers'; // 或预分词方案，见下

// 启动时加载一次；模型 ~40MB 内存常驻，单批推理 <100ms
const session = await ort.InferenceSession.create(modelPath);

export async function scoreWithJev(candidates, context, groupName): Promise<number[] | null> {
  // 原有 jevAvailable() 判断保留；失败退避逻辑保留
  const inputs = candidates.map((msg, i) => {
    const prev = context.at(-1)?.text ?? '';
    return `${groupName} [SEP] ${prev} [SEP] ${msg.text}`;
  });
  // HuggingFace tokenizers（onnxruntime-node 侧）→ input_ids / attention_mask
  // → session.run → softmax(logits[1]) → 数组与 candidates 一一对应
}
```

集成后删掉 `jev.ts` 的远端 fetch 与 `JEV_BACKOFF_MS` 退避（本地失败概率≈0），保留阈值语义。

## 4. 阈值必须重扫（手册 §3 第 4 步）

本地模型分数分布 ≠ TypeSafe。先跑 `python train/jev/04_thresholds.py` 拿建议值，
再用 `pnpm --filter server exec tsx src/pipeline/jev-calibrate.ts` 在真实口径下复扫，
最后更新 `jev.ts` 的 `JEV_DROP_BELOW` / `JEV_URGENT_AT`（改完跑 eval 全绿再提交）。

**合成数据 v1 实测**（2026-09，10k 样本，见 `train/artifacts/jev-thresholds.log`）：

| 项 | 值 |
|---|---|
| 分数分离度 | 真通知最低 0.946 / 非通知最高 0.005（天然两簇，合成语料较易） |
| 建议 `JEV_DROP_BELOW` | **0.45**（最大安全线 0.50 − 0.05 余量；可丢 74% 候选） |
| `JEV_URGENT_AT=0.8` | 命中 518/518，误报 0 |
| 单批 30 条 CPU 时延 | p50 ≈ 90–150ms（笔记本功耗状态敏感；插电+性能模式更稳） |

> 注意：以上是合成数据上的表现，真实群聊数据接入后必须重扫（教师标注/人工标注版数据重跑 04）。
> ORT 默认线程配置实测最快；不要手动设大线程数（P/E 核混合 CPU 会争核变慢）。

## 5. 交付判据（验收门 6）

- 真通知召回 100%（现有口径：不丢参考真通知）
- 误丢 0
- 单批 p90 < 100ms（30 条/批，CPU）

## 6. 与 TypeSafe 语义的对齐（替换时不要丢语义）

本地 Jev 是 TypeSafe **Noul 原语**（"条件是否成立"→ 一个概率）的等价物，不是 Choice/Score：

| TypeSafe 概念 | 本地 Jev 对应 |
|---|---|
| Noul 的概率 | `softmax(logits[1])` 单值 ∈ [0,1]，**只表示"这条消息是否含需行动事项"** |
| `instructions` / `criteria` | 固化为训练语料口径（`gen-jev-data.ts` 的正负样本定义）；改口径必须重训 |
| confidence（分布集中度） | 本地输出无独立 confidence 概念，**不要伪造**；需要不确定性时用阈值余量表达 |
| 多标签（若干 Noul 各问一遍） | 现在是单标签；要拆"是否考试/是否改期"需另训一个头或第二个模型 |

阈值语义与手册一致：`JEV_DROP_BELOW` 以下丢弃候选（省 LLM 调用），`JEV_URGENT_AT` 以上直接标紧急。
两者都在**真实数据上重扫**后才可上线，合成数据的 0.45/0.8 只是起点。

## 7. 零代码验收链（替换后必跑）

```powershell
# 1) 本地 ONNX 接入后，关掉远端：.env 里 ENABLE_JEV=true（不再需要 TypeSafe key）
# 2) 阈值复扫
pnpm --filter server exec tsx src/pipeline/jev-calibrate.ts
# 3) 全链路考卷（Jev 会真正参与候选过滤）
pnpm --filter server exec tsx src/pipeline/eval.ts
```

`eval.ts` 输出里 `Jev` 列是 Jev 通道耗时；替换成功后应看到 Jev 毫秒级（此前远端是网络往返）。

## 8. `jev-calibrate` 验收门实测（本地模式，2026-09-30）

**先修了门本身的一个问题**：`jev-calibrate.ts` 原先硬性要求 `TYPESAFE_API_KEY`，
而产品决策（2026-09-29）已把 `FASTJUDGE_MODE` 默认设为 `local` —— 默认配置下这个验收门
根本跑不起来。已改为「有本地 Jev 即可运行」，远端 key 仅在 `jev/dual` 模式下需要。

实测（6 剧本，115 候选，参考真通知 30 条，走队友脚手架的 TF-IDF 模型）：

| 丢弃阈值 | 真通知召回 | 候选丢弃率 |
|---|---|---|
| 0.05 | 93.3% | 34.8% |
| 0.10 | 90.0% | 40.9% |
| 0.15 | 90.0% | 43.5% |
| **0.20（当时线上值）** | **86.7%** | 47.0% |
| 0.30 | 83.3% | 53.0% |
| 0.50 | 76.7% | 60.9% |

**关键结论：本地 TF-IDF 快判在任何阈值下都到不了 100% 召回**（最好 93.3% @0.05），
而本项目验收判据是「真通知召回 100%、误杀 0」（§5）。因此：

1. **别把 `JEV_DROP_BELOW` 调到 0.05 硬凑召回** —— 丢了 35% 候选，仍会漏 2 条；
2. **按 §6 做级联**：fastjudge 当第一级（2ms），把分数落在中间区间的候选交给
   `train/models/jev-classifier-onnx`（rbt3-ONNX，语义更强）复判；
3. 不做级联就只能把阈值压到 ≈0 ＝放弃"用 Jev 省 LLM 调用"的收益。

**延迟实测（重要）**：`Jev：15 次，p50 18ms，p90 24ms，最大 6232ms`。
最大那条是**常驻 worker 冷启动**（python + jieba 词典 + joblib 加载）——
默认 `JEV_TIMEOUT_MS=3000`（代码下限 5000）会把首次请求判成超时并触发 30s 退避。
建议启动时预热一次，或把首次请求超时单独放宽到 ≥10s。

> sklearn 版本：仓库内 `local-jev-v1.joblib` 由 1.6.1 训练，用 1.9.1 加载会打
> `InconsistentVersionWarning`（分数仍合理）；`classrep-fastjudge/requirements.txt`
> 把 sklearn 钉在 <1.7 是对的，验收环境别用更高版本。
