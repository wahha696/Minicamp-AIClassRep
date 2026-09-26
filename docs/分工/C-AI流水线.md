# 分工 C：AI 流水线（规则过滤 → LLM 提取 → 事件合并）+ 仿真数据

> **给 AI 的开场白（复制粘贴）**：
> 你在开发 ClassRep 项目。请先完整阅读 `架构.md`、`需求文档.md`、`docs/分工/00-总约定.md`，然后阅读本文件。我负责「分工 C」。**只修改本文件「我的文件」列出的路径**；共享类型、表结构、函数签名、API 格式以 `00-总约定.md` 为准，不得擅自修改。每次只做我指定的一个任务，做完告诉我怎么验证。

## 我的前提条件

任意电脑，Node ≥ 22.13 + pnpm。仓库根有 `.env`（组长私下给），含 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`（OpenAI 兼容协议，如 DeepSeek / 通义千问）。等 B 的骨架（M0）合进 main 后开工；**C1、C2 不依赖骨架，可以第一天就做。**

## 我的文件

```
data/mock/*.json
apps/server/src/pipeline/filter.ts
apps/server/src/pipeline/extract.ts
apps/server/src/pipeline/reconcile.ts
apps/server/src/pipeline/scheduler.ts
apps/server/src/pipeline/index.ts
apps/server/src/pipeline/*.test.ts
```

## 我依赖别人的

B 的 `db`（`node:sqlite` 的 `DatabaseSync`）、`env`、`types.ts`。我直接读写 `messages`（只改 `processed`、`filtered_out`）、`events`、`event_sources`、`event_history`（表结构见 `00-总约定.md` §5）。

## 任务清单（按顺序，一次给 AI 一条）

**C1. 仿真剧本 `data/mock/`**（格式见 `00-总约定.md` §8；**只写相对时间**）
至少 5 个文件，合计 ≥ 300 条，其中 ≥ 50% 是噪声（收到、哈哈哈、+1、约饭、表情、[图片]）：
- `reschedule.json`「改期场景」：高数课代表发「明天下午两点 A301 小测」，几十条闲聊后，班长发「小测改到周五下午两点，教室改 A203」。**这是 Demo 主剧本，最重要。**
- `cancel.json`「取消场景」：社团周六活动 → 后来「周六活动取消」。
- `assignment.json`「作业 DDL」：「本周五 23:59 前交实验报告到学习通」等 3~4 个作业。
- `meeting.json`「开会」：班委会「今晚 8 点 3 号楼 201」。
- `noisy.json`「大群闲聊」：一个 100+ 条几乎全是闲聊、只夹 2 条真通知的大群。
- 另外两个陷阱：同群两个名字相近但不同的考试（「高数期中」和「线代期中」），不应被合并。

**C2. `filter.ts`：`isNoise(text: string): boolean`**
按 `需求文档.md` FR-3.1：去掉空白和占位符（`[图片]` `[表情]` `[at]` 等）后为空 → 噪声；长度 < 4 且不含数字/时间词（今天明天后天周几星期点号月日上午下午晚上截止ddl等）→ 噪声；命中 `^(收到|好的|好滴|ok|OK|嗯+|哈+|6+|\+1|谢谢|知道了|1+|啊+|草|？+|\?+)[!！。~～]*$` → 噪声。
验收：vitest 覆盖 20+ 例；对 `data/mock` 全部消息过滤率 ≥ 50%，且剧本里所有真通知都**不**被过滤（单测里断言）。

**C3. `extract.ts`：`extractEvents(input): Promise<ExtractedEvent[]>`**
- 输入：`{ groupName, candidates: 消息[], context: 消息[], now: number, activeEvents: 该群近 14 天 active 事件的精简列表 }`。
- 用 `openai` 包：`new OpenAI({ baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY })`，`response_format: { type: 'json_object' }`，`temperature: 0`。
- system prompt 要点（中文写）：你是大学生的课代表；当前时间 `YYYY-MM-DD HH:mm 星期X（Asia/Shanghai）`；只提取需要学生行动或到场的事项；相对时间换算为绝对时间，输出 `YYYY-MM-DDTHH:mm+08:00` 字符串；「周五」指本周五，若已过则下周五；只有日期没时间的截止 → 当天 23:59；不确定的字段给 null；闲聊返回空数组；**若是对下面已有事件的改期/取消/补充，填 `update_of` 为已有事件 id，并用 `action` 说明**。
- 输出 zod schema：
  ```ts
  { events: Array<{
      action: 'create' | 'update' | 'cancel';
      update_of: number | null;
      type: EventType; title: string; description: string;
      start_at: string | null; end_at: string | null; deadline_at: string | null;
      location: string | null; action_required: string | null;
      confidence: number; source_message_ids: string[];
  }> }
  ```
  返回前把时间字符串转为毫秒时间戳（`Date.parse`）。
- 失败处理（FR-5.4）：JSON 解析或 zod 校验失败 → 把错误信息附在对话里重试 1 次 → 再失败返回 `[]` 并 `console.warn`，**不抛异常**。网络错误同样返回 `[]`，并把 stats 的 `llm` 置为 `'error'`；成功一次置回 `'ok'`；`LLM_API_KEY` 为空时不调用，`llm='unconfigured'`。
- `source_message_ids` 里不在输入中的 id 要丢弃。
- 验收：写一个 `pnpm --filter server exec tsx src/pipeline/try-extract.ts reschedule` 小脚本（可提交），打印对剧本的提取结果；「明天下午两点」换算正确。

**C4. `reconcile.ts`：`applyEvents(groupId, extracted, sourceMsgs): void`**
在一个事务里：
- `action='update'` 且 `update_of` 指向同群 active 事件 → 只覆盖**非 null** 且**值不同**的字段，`version+1`，写 `event_history`（`changed_fields` 形如 `{"start_at":{"from":旧,"to":新}}`），追加 `event_sources`。
- `action='cancel'` 且 `update_of` 有效 → `status='cancelled'`，写 history（`status` 字段变化），追加来源。
- `action='create'`：再做一次兜底（FR-6.1）——同群、同 type、active、标题字符二元组 Jaccard > 0.6 → 当作 update 处理；否则新建。`confidence < 0.6` 的新建事件 `status='pending_confirm'`（FR-6.4）。
- `update_of` 无效（不存在/不同群）→ 当作 create。
- `event_sources` 存消息**快照**（sender_name、text、sent_at）。
- 验收（vitest，**不调 LLM**，直接喂假的 extracted）：①先 create「高数小测 周二」再 update 到周五 → 库里 1 条、version=2、history 1 条、sources 2 条；②cancel → status=cancelled；③「高数期中」「线代期中」不合并。

**C5. `scheduler.ts` + `index.ts`**
- `startScheduler()`：每 5 秒检查一次；某群「未处理消息数 ≥ 15」或「最早一条未处理消息已等 ≥ 20 秒」→ 处理该群。同一时刻只跑一个批次（加锁）。
- 处理一个群：取该群 `processed=0` 的消息（按 sent_at 升序，最多 30 条）→ 规则过滤，噪声置 `filtered_out=1` → 剩下的作为 candidates，另取它们之前的 10 条消息作 context → `extractEvents` → `applyEvents` → 全部置 `processed=1`（**LLM 失败也置 1，避免死循环**）。
- 候选为空则不调 LLM。
- `runPipelineNow()`：立即把所有群处理完（循环直到没有 `processed=0`），等待正在跑的批次结束后再开始。
- `getPipelineStats()`：`filtered_count` 从库里 `COUNT(*) WHERE filtered_out=1`；`llm_called_count` 内存累加；`llm` 状态见 C3。
- 预留 Jev：流水线写成 `stages: Stage[]` 数组依次执行（filter → extract → reconcile），`架构.md` §6 要求以后插一个 stage 即可。

**C6. 调 prompt（M1 联调）**
和 B、D 一起跑所有剧本，把错误案例记下来改 prompt，直到：改期不产生两条、取消能标记、相对时间全对、`noisy.json` 只出 2 个事件。每改一次 prompt 就把 5 个剧本全跑一遍对比。

## 我不做

HTTP 路由、NapCat、前端、建表。需要新字段或新接口时，在群里提，由 B 改。
