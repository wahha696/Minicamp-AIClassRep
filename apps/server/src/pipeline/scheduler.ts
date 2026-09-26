// 调度（FR-5）：轮询 messages.processed=0，按群分批跑 stages（filter → extract → reconcile）。
// 别人入库后不用通知这里；同一时刻只跑一个批次；一批消息处理完置 processed=1。
// 例外：AI 连不上（网络 / 证书 / 服务挂了）时这批不置已处理，等 LLM_RETRY_MS 后重试，免得通知白白丢掉。
import { db } from '../db/index.js';
import type { Message } from '../types.js';
import { type ExtractedEvent, extractEvents } from './extract.js';
import { isNoise } from './filter.js';
import { llmStats } from './stats.js';
import { applyEvents, listActiveEvents } from './reconcile.js';

const TICK_MS = 5_000;
const MIN_PENDING = 15; // 攒够这么多条就处理
const MAX_WAIT_MS = 20_000; // 或者最早一条已经等了这么久
const BATCH = 30;
const CONTEXT = 10;
export const LLM_RETRY_MS = 60_000; // AI 连不上后，隔这么久再试

let llmRetryAt = 0; // 在这之前不自动处理（手动 runPipelineNow 不受限）

/** 一个批次在各 stage 之间传递的状态 */
export interface Batch {
  groupId: string;
  groupName: string;
  now: number;
  messages: Message[]; // 本批全部消息（按 sent_at 升序）
  candidates: Message[]; // 过滤后留下的
  extracted: ExtractedEvent[];
  llmFailed?: boolean; // AI 没调通：这批留着下次重试
}

/** 以后插 Jev 只需要往 stages 里加一个（架构.md §6） */
export type Stage = (b: Batch) => void | Promise<void>;

const ids = (ms: Message[]) => JSON.stringify(ms.map((m) => m.message_id));

const filterStage: Stage = (b) => {
  const noise = b.messages.filter((m) => isNoise(m.text));
  b.candidates = b.messages.filter((m) => !isNoise(m.text));
  if (noise.length) {
    db.prepare('UPDATE messages SET filtered_out = 1 WHERE message_id IN (SELECT value FROM json_each(?))').run(
      ids(noise),
    );
  }
};

const extractStage: Stage = async (b) => {
  const first = b.candidates[0];
  if (!first) return; // 候选为空不调 LLM
  const context = (
    db
      .prepare(
        `SELECT message_id, group_id, sender_name, text, sent_at FROM messages
         WHERE group_id = ? AND filtered_out = 0 AND sent_at < ?
         ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(b.groupId, b.messages[0]!.sent_at, CONTEXT) as unknown as Omit<Message, 'group_name'>[]
  )
    .reverse()
    .map((m) => ({ ...m, group_name: b.groupName }));
  const failedBefore = llmStats.failed;
  b.extracted = await extractEvents({
    groupName: b.groupName,
    candidates: b.candidates,
    context,
    now: b.now,
    activeEvents: listActiveEvents(b.groupId, b.now),
  });
  if (llmStats.failed > failedBefore) {
    b.llmFailed = true;
    throw new LlmUnavailable(); // 后面的 stage 不用跑了
  }
};

class LlmUnavailable extends Error {}

const reconcileStage: Stage = (b) => {
  applyEvents(b.groupId, b.extracted, b.candidates);
};

export const stages: Stage[] = [filterStage, extractStage, reconcileStage];

// ---------- 批次 ----------

interface PendingGroup {
  group_id: string;
  name: string;
  pending: number;
  oldest: number; // 最早一条未处理消息的入库时间
}

/** 有未处理消息的群（关掉的群不处理）。等待时间按入库时间算：历史补齐 / 回放的 sent_at 本来就是过去。 */
function pendingGroups(): PendingGroup[] {
  return db
    .prepare(
      `SELECT m.group_id, COALESCE(g.name, m.group_id) AS name, COUNT(*) AS pending, MIN(m.created_at) AS oldest
       FROM messages m LEFT JOIN groups g ON g.group_id = m.group_id
       WHERE m.processed = 0 AND COALESCE(g.enabled, 1) = 1
       GROUP BY m.group_id ORDER BY oldest`,
    )
    .all() as unknown as PendingGroup[];
}

/** 处理某群最早的一批未处理消息，返回置为已处理的条数 */
async function processBatch(g: PendingGroup): Promise<number> {
  const rows = db
    .prepare(
      `SELECT message_id, group_id, sender_name, text, sent_at FROM messages
       WHERE group_id = ? AND processed = 0 ORDER BY sent_at, message_id LIMIT ?`,
    )
    .all(g.group_id, BATCH) as unknown as Omit<Message, 'group_name'>[];
  if (rows.length === 0) return 0;

  const b: Batch = {
    groupId: g.group_id,
    groupName: g.name,
    now: Date.now(),
    messages: rows.map((m) => ({ ...m, group_name: g.name })),
    candidates: [],
    extracted: [],
  };
  try {
    for (const stage of stages) await stage(b);
  } catch (e) {
    if (!b.llmFailed) console.warn(`[pipeline] 群 ${g.group_id} 这批处理出错，消息仍置为已处理：`, e);
  }
  if (b.llmFailed) {
    llmRetryAt = Date.now() + LLM_RETRY_MS;
    console.warn(`[pipeline] AI 连不上，群 ${g.group_id} 的 ${rows.length} 条消息 ${LLM_RETRY_MS / 1000}s 后重试`);
    return 0;
  }
  const { changes } = db
    .prepare('UPDATE messages SET processed = 1 WHERE message_id IN (SELECT value FROM json_each(?))')
    .run(ids(b.messages));
  return Number(changes);
}

/** 一轮给每个该处理的群跑一批，直到没有群该处理。force=true 时不看阈值。 */
async function drain(force: boolean, now?: number): Promise<void> {
  for (;;) {
    const t = now ?? Date.now();
    if (!force && Date.now() < llmRetryAt) return; // AI 刚连不上，先歇一会
    const due = pendingGroups().filter((g) => force || g.pending >= MIN_PENDING || t - g.oldest >= MAX_WAIT_MS);
    if (due.length === 0) return;
    let progress = 0;
    for (const g of due) progress += await processBatch(g);
    if (progress === 0) return; // 置不上 processed 就别空转
  }
}

// ---------- 锁 ----------

let queue: Promise<void> = Promise.resolve();
let jobs = 0;

/** 排队执行，保证同一时刻只有一个批次在跑 */
function exclusive(fn: () => Promise<void>): Promise<void> {
  jobs++;
  const run = queue.then(fn).finally(() => jobs--);
  queue = run.catch(() => {});
  return run;
}

/** 调度器的一次检查。已经有任务在跑 / 排队就跳过。now 只给测试用。 */
export function tick(now?: number): Promise<void> {
  if (jobs > 0) return Promise.resolve();
  return exclusive(() => drain(false, now)).catch((e) => console.warn('[pipeline] 调度出错：', e));
}

/** 立即把所有群处理完；有批次在跑就等它结束再开始。不抛异常。 */
export function runPipelineNow(): Promise<void> {
  return exclusive(() => drain(true)).catch((e) => console.warn('[pipeline] 立即处理出错：', e));
}

let timer: ReturnType<typeof setInterval> | undefined;

/** 测试用：清掉「AI 连不上，歇一会」的状态 */
export function resetLlmRetry(): void {
  llmRetryAt = 0;
}

export function startScheduler(): void {
  timer ??= setInterval(() => void tick(), TICK_MS);
}

export function stopScheduler(): void {
  clearInterval(timer);
  timer = undefined;
}
