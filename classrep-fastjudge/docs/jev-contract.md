# Jev 快判接口契约（与 Minicamp-AIClassRep 源码对齐）

> 源码基准：本地 clone `/workspace/Minicamp-AIClassRep`（远程 `https://github.com/wahha696/Minicamp-AIClassRep`）。
> 本文档只描述「规则过滤之后、LLM 抽取之前」的 Jev 层，供本地小模型替代时对齐输入/输出与失败回退。

## 1. 流水线位置

```
规则过滤 (filter.isNoise) → Jev 快判 (scoreWithJev) → LLM 抽取 (extractEvents) → Reconcile
```

引用：

| 职责 | 路径 |
|------|------|
| 规则过滤 | `apps/server/src/pipeline/filter.ts` |
| Jev 打分 | `apps/server/src/pipeline/jev.ts` |
| 调度与阈值消费 | `apps/server/src/pipeline/scheduler.ts` |
| 配置 | `apps/server/src/ai-settings.ts`（`getJevConfig`）、`apps/server/src/env.ts` |
| 校准脚本 | `apps/server/src/pipeline/jev-calibrate.ts` |
| 单元测试 | `apps/server/src/pipeline/jev.test.ts` |
| 消息类型 | `apps/server/src/types.ts`（`Message`） |

`scheduler.ts` 中 stages 顺序（约 L113）：

```ts
export const stages: Stage[] = [filterStage, jevStage, extractStage, reconcileStage];
```

## 2. 输入契约

### 2.1 函数签名

```ts
// apps/server/src/pipeline/jev.ts
export async function scoreWithJev(
  candidates: Message[],
  context: Message[],
  groupName: string,
): Promise<number[] | null>
```

### 2.2 `Message` 字段（打分实际用到的）

来自 `apps/server/src/types.ts`：

| 字段 | 用途 |
|------|------|
| `sender_name` | 写入 Jev `state.messages` / `previous_messages` |
| `text` | 同上；规则层已把消息段转成纯文本（含 `[图片]`/`[at]` 等占位符） |
| `message_id` | 调度缓存分数用（`jevScores: Map<message_id, number>`） |
| `group_id` / `group_name` / `sent_at` | 调度侧使用；HTTP body 里只用 `groupName` 与候选/上下文的 name+text |

### 2.3 候选从哪来

`filterStage` 先跑 `isNoise(text)`，噪声置 `filtered_out=1`，**只有非噪声**进入 `b.candidates`，再交给 Jev（`scheduler.ts` L54–L84）。

上下文：此前最近 **10** 条非噪声消息（`CONTEXT = 10`）。批次大小上限 **30**（`BATCH = 30`）。

### 2.4 远程 HTTP 请求体（当前线上 Jev）

- Endpoint：`https://api.typesafe.ai/v1/systemone`（`jev.ts` L9）
- Auth：`Bearer ${TYPESAFE_API_KEY}`（或网页保存的 typesafe key）
- Model：`env.JEV_MODEL`，默认 `jev-latest`
- Timeout：`env.JEV_TIMEOUT_MS`，默认 **3000ms**
- Body 结构：

```json
{
  "model": "jev-latest",
  "state": {
    "group_name": "<群名>",
    "previous_messages": [{ "sender_name": "...", "text": "..." }],
    "messages": [{ "sender_name": "...", "text": "..." }]
  },
  "questions": {
    "message_0": {
      "type": "noul",
      "instructions": "结合群聊上下文，`messages[0]` 是否提供可能影响学生日程或待办的具体信息？只判断这条消息，其他消息仅作上下文。",
      "criteria": {
        "true": "考试、作业、会议、活动、通知的时间、地点、要求，或其改期、取消、补充、确认；已说定具体时间或日期的聚餐、吃饭、出游、打球等约定也算；零碎但可与上下文拼成这些信息的片段也算。",
        "false": "纯闲聊、寒暄、表情、无关讨论，或没有说定时间的随口提议、询问，例如“晚上约饭吗”。"
      }
    }
  }
}
```

每条候选对应一个 `message_i` 问题；**一批一次请求**。

## 3. 输出契约

### 3.1 远程响应（Zod 校验）

```ts
// jev.ts L20–L21
const answerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) });
```

期望：`answers.message_i.noul ∈ [0, 1]`，含义为「含日程信息」的概率。

### 3.2 函数返回值

- 成功：`number[]`，与 `candidates` **一一对应、同序**
- 失败 / 未配置 / 退避期 / 候选为空：`null`

缺某一条 `message_i` 的答案会抛错并走失败路径。

## 4. 分数如何被消费（调度阈值）

常量（`jev.ts` L14–L18）：

| 常量 | 值 | 含义 |
|------|-----|------|
| `JEV_DROP_BELOW` | `0.2` | **低于**此分：丢弃，不送 LLM（`filtered_out=1`） |
| `JEV_URGENT_AT` | `0.8` | **不低于**此分：视为确定通知，缩短等待立刻处理 |
| `JEV_BACKOFF_MS` | `30000` | 失败后 30s 内不再调 Jev |

`jevStage`（`scheduler.ts` L66–L84）：

- 未打到分的候选：`(jevScores.get(id) ?? 1)` → 默认按 **1.0** 保留，交给 LLM
- `score < 0.2` → 从 `candidates` 剔除，不进 LLM

`isDue` 等待策略（文件头注释 + L230+）：

- 有 `score >= 0.8`：安静 `QUIET_MS=3s` 或最多 `URGENT_MAX_WAIT_MS=10s`
- 全部噪声或全部 `< 0.2`：立刻收尾（不调 LLM）
- 中间不确定：等 `UNCERTAIN_WAIT_MS=8s`
- Jev 不可用：回退到攒批 `MIN_PENDING=15` / `MAX_WAIT_MS=20s`

**错误代价不对等**（`jev.ts` 注释）：误丢真通知 ≫ 多调一次 LLM → 本地模型应优先压低误杀率。

## 5. 失败与回退 LLM

| 条件 | 行为 |
|------|------|
| `ENABLE_JEV=false` | `jevAvailable()=false` → `scoreWithJev` 返回 `null`，候选全交 LLM |
| 无 API Key | 同上 |
| 在 `backoffUntil` 内 | 同上（失败后歇 30s） |
| HTTP 非 2xx / 超时 / JSON 不合 schema / 缺答案 | catch → `return null`，设 backoff，console.warn（不打印 key/正文） |
| `scores === null` | `jevStage` 不写分；`(score ?? 1) < 0.2` 为假 → **全部保留给 LLM** |

结论：本地快判若失败，应同样返回「无分数 / 全保留」，与现网一致，保证可用性。

## 6. 配置开关

| 变量 | 默认 | 说明 |
|------|------|------|
| `ENABLE_JEV` | `true` | 总开关 |
| `TYPESAFE_API_KEY` | 空 | 或网页 `llm.json` 里 typesafe key |
| `JEV_MODEL` | `jev-latest` | |
| `JEV_TIMEOUT_MS` | `3000` | |

## 7. 本地快判替代时的最小兼容面

要实现「可插拔替换 `scoreWithJev`」而不改调度，本地模型应：

1. **输入**：`candidates: {sender_name, text}[]` + `context` + `group_name`（可先只用单条 `text`，上下文作为增强）
2. **输出**：`number[] | null`，每条 ∈ [0,1]，语义对齐 noul
3. **失败**：返回 `null`（或抛错由包装层转 null），触发 LLM 回退
4. **延迟目标**：现网超时 3s；本地目标毫秒～百毫秒级（见 `docs/acceptance-metrics.md`）

粗类型标签（作业/考试/…）**不是**现网 Jev 输出，仅为多任务辅助；路由仍以连续分数 + 阈值 `0.2 / 0.8` 为准。
