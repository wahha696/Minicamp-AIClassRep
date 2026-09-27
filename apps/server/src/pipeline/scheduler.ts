// 调度（FR-5）：轮询 messages.processed=0，按群分批跑 stages（filter → Jev → extract → reconcile）。
// 别人入库后不用通知这里；同一个群同一时刻只跑一个批次，不同群最多并发 GROUP_CONCURRENCY 个；一批消息处理完置 processed=1。
// 例外：AI 连不上（网络 / 证书 / 服务挂了）时这批不置已处理，等 LLM_RETRY_MS 后重试，免得通知白白丢掉。
//
// 什么时候处理一个群（isDue）——Jev 分数决定等多久（阈值见 jev.ts）：
//   · 攒够 MIN_PENDING 条，或最早一条等了 MAX_WAIT_MS（Jev 不可用时的老规则，兜底）；
//   · 有 Jev「确定是通知」的消息（≥ JEV_URGENT_AT）：群里安静 QUIET_MS 就处理（给老师留几秒发完后续补充），最多等 URGENT_MAX_WAIT_MS；
//   · 待处理的全是噪声或 Jev「确定不是」：立刻收尾（不调 LLM，只是置已处理）；
//   · 其余（Jev 拿不准）：等 UNCERTAIN_WAIT_MS 攒一攒上下文再交给 LLM。
// Jev 分数在攒批期间就提前打好（triage），处理批次时直接复用，不再多等一次 Jev。
import { db, dbGeneration, onAccountSwitch } from '../db/index.js';
import type { Message } from '../types.js';
import { type ExtractStatus, type ExtractedEvent, extractEvents } from './extract.js';
import { isNoise } from './filter.js';
import { JEV_DROP_BELOW, JEV_URGENT_AT, jevAvailable, scoreWithJev } from './jev.js';
import { jevStats, resetPipelineStats } from './stats.js';
import { applyEvents, listActiveEvents } from './reconcile.js';

const TICK_MS = 1_000;
const MIN_PENDING = 15; // 攒够这么多条就处理
const MAX_WAIT_MS = 20_000; // 或者最早一条已经等了这么久
const QUIET_MS = 3_000; // 有确定的通知时：群里这么久没新消息就处理
const URGENT_MAX_WAIT_MS = 10_000; // 有确定的通知时最多等这么久（群里一直有人说话也不再等）
const UNCERTAIN_WAIT_MS = 8_000; // Jev 拿不准的消息等这么久再交给 LLM
const TRIAGE_MIN_INTERVAL_MS = 2_000; // 同一个群两次分诊（Jev 请求）的最小间隔
const GROUP_CONCURRENCY = 3; // 不同群同时处理的批次数（LLM 调用并发）
const BATCH = 30;
const CONTEXT = 10;
const SCORE_CACHE_MAX = 10_000;
export const LLM_RETRY_MS = 60_000; // AI 连不上后，隔这么久再试

let llmRetryAt = 0; // 在这之前不自动处理（手动 runPipelineNow 不受限）

/** 待处理消息的 Jev 分数（message_id → 分数）。批次处理完就删；重启丢了也没关系，会重新打分。 */
const jevScores = new Map<string, number>();

/** 一个批次在各 stage 之间传递的状态 */
export interface Batch {
  groupId: string;
  groupName: string;
  now: number;
  messages: Message[]; // 本批全部消息（按 sent_at 升序）
  context: Message[]; // 此前最近 10 条非噪声消息
  candidates: Message[]; // 过滤后留下的
  extracted: ExtractedEvent[];
  llmFailed?: boolean; // AI 没调通：这批留着下次重试
  timing: { jevMs: number; llmMs: number };
}

export type Stage = (b: Batch) => void | Promise<void>;

const ids = (ms: Message[]) => JSON.stringify(ms.map((m) => m.message_id));

const filterStage: Stage = (b) => {
  const noise = b.messages.filter((m) => isNoise(m.text));
  b.candidates = b.messages.filter((m) => !isNoise(m.text));
  if (noise.length) {
    // messages 主键是 (group_id, message_id)（schema v2）：更新必须带上群
    db.prepare('UPDATE messages SET filtered_out = 1 WHERE group_id = ? AND message_id IN (SELECT value FROM json_each(?))').run(
      b.groupId,
      ids(noise),
    );
  }
};

const jevStage: Stage = async (b) => {
  // 攒批期间已打过分的直接用；剩下的（大批积压、刚来的）一次请求补打
  const unscored = b.candidates.filter((m) => !jevScores.has(m.message_id));
  if (unscored.length) {
    const t0 = Date.now();
    const scores = await scoreWithJev(unscored, b.context, b.groupName);
    b.timing.jevMs = Date.now() - t0;
    scores?.forEach((s, i) => jevScores.set(unscored[i]!.message_id, s));
  }
  // 没分数（未配置 / 失败）的保留，交给 LLM
  const dropped = b.candidates.filter((m) => (jevScores.get(m.message_id) ?? 1) < JEV_DROP_BELOW);
  if (dropped.length) {
    const { changes } = db.prepare(
      'UPDATE messages SET filtered_out = 1 WHERE group_id = ? AND filtered_out = 0 AND message_id IN (SELECT value FROM json_each(?))',
    ).run(b.groupId, ids(dropped));
    jevStats.filtered += Number(changes);
    const gone = new Set(dropped.map((m) => m.message_id));
    b.candidates = b.candidates.filter((m) => !gone.has(m.message_id));
  }
};

const extractStage: Stage = async (b) => {
  const first = b.candidates[0];
  if (!first) return; // 候选为空不调 LLM
  const status: ExtractStatus = { llmFailed: false };
  const t0 = Date.now();
  b.extracted = await extractEvents({
    groupId: b.groupId,
    groupName: b.groupName,
    candidates: b.candidates,
    context: b.context,
    now: b.now,
    activeEvents: listActiveEvents(b.groupId, b.now),
  }, undefined, status);
  b.timing.llmMs = Date.now() - t0;
  if (status.llmFailed) {
    b.llmFailed = true;
    throw new LlmUnavailable(); // 后面的 stage 不用跑了
  }
};

class LlmUnavailable extends Error {}

const reconcileStage: Stage = (b) => {
  applyEvents(b.groupId, b.extracted, b.candidates);
};

export const stages: Stage[] = [filterStage, jevStage, extractStage, reconcileStage];

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

type Row = Omit<Message, 'group_name'> & { created_at: number };

/** 某群最早的一批未处理消息（按 sent_at 升序） */
function pendingRows(groupId: string): Row[] {
  return db
    .prepare(
      `SELECT message_id, group_id, sender_name, text, sent_at, created_at FROM messages
       WHERE group_id = ? AND processed = 0 ORDER BY sent_at, message_id LIMIT ?`,
    )
    .all(groupId, BATCH) as unknown as Row[];
}

/** 某时刻之前最近 CONTEXT 条非噪声消息（升序） */
function contextBefore(g: PendingGroup, sentAt: number): Message[] {
  return (
    db.prepare(
      `SELECT message_id, group_id, sender_name, text, sent_at FROM messages
       WHERE group_id = ? AND filtered_out = 0 AND sent_at < ?
       ORDER BY sent_at DESC LIMIT ?`,
    ).all(g.group_id, sentAt, CONTEXT) as unknown as Omit<Message, 'group_name'>[]
  ).reverse().map((m) => ({ ...m, group_name: g.name }));
}

const toMessage = (g: PendingGroup) => ({ created_at: _, ...m }: Row): Message => ({ ...m, group_name: g.name });

/** 处理某群最早的一批未处理消息，返回置为已处理的条数 */
async function processBatch(g: PendingGroup): Promise<number> {
  const gen = dbGeneration(); // 换号守卫：攒批期间切了账号，下面的读属于旧号，绝不能写进新号库
  const rows = pendingRows(g.group_id);
  if (rows.length === 0) return 0;

  const b: Batch = {
    groupId: g.group_id,
    groupName: g.name,
    now: Date.now(),
    messages: rows.map(toMessage(g)),
    context: contextBefore(g, rows[0]!.sent_at),
    candidates: [],
    extracted: [],
    timing: { jevMs: 0, llmMs: 0 },
  };
  try {
    for (const stage of stages) {
      await stage(b);
      if (dbGeneration() !== gen) return 0; // 中途换号：这批按放弃处理
    }
  } catch (e) {
    if (!b.llmFailed) console.warn(`[pipeline] 群 ${g.group_id} 这批处理出错，消息仍置为已处理：`, e);
  }
  if (b.llmFailed) {
    llmRetryAt = Date.now() + LLM_RETRY_MS;
    console.warn(`[pipeline] AI 连不上，群 ${g.group_id} 的 ${rows.length} 条消息 ${LLM_RETRY_MS / 1000}s 后重试`);
    return 0;
  }
  const { changes } = db
    .prepare('UPDATE messages SET processed = 1 WHERE group_id = ? AND message_id IN (SELECT value FROM json_each(?))')
    .run(b.groupId, ids(b.messages));
  for (const m of b.messages) jevScores.delete(m.message_id);
  if (b.candidates.length) {
    // 延迟排查用：从最早一条入库到处理完，各段各花了多久
    const waited = b.now - Math.min(...rows.map((r) => r.created_at));
    console.log(
      `[pipeline] 群 ${g.name}：${rows.length} 条 → LLM ${b.candidates.length} 条，等待 ${(waited / 1000).toFixed(1)}s，Jev ${b.timing.jevMs}ms，LLM ${b.timing.llmMs}ms，事件 ${b.extracted.length} 个`,
    );
  }
  return Number(changes);
}

// ---------- 分诊：攒批期间提前打 Jev 分数 ----------

const lastTriage = new Map<string, number>(); // 群 → 上次分诊时间

/** 给某群还没打分的待处理候选打分（一群一次请求）。已打分的待处理消息作为上下文，零碎的补充也能看懂。 */
async function triage(g: PendingGroup): Promise<void> {
  // 刷屏的群每秒都有新消息：同一个群至少隔 TRIAGE_MIN_INTERVAL_MS 才再打一次分，攒几条一起问
  const now = Date.now();
  if (now - (lastTriage.get(g.group_id) ?? 0) < TRIAGE_MIN_INTERVAL_MS) return;
  lastTriage.set(g.group_id, now);
  const rows = pendingRows(g.group_id).map(toMessage(g));
  if (rows.length === 0) return; // B5：空批次不能碰 rows[0]
  const candidates = rows.filter((m) => !isNoise(m.text));
  const firstNew = candidates.findIndex((m) => !jevScores.has(m.message_id));
  if (firstNew < 0) return;
  const unscored = candidates.slice(firstNew).filter((m) => !jevScores.has(m.message_id));
  const context = [...contextBefore(g, rows[0]!.sent_at), ...candidates.slice(0, firstNew)].slice(-CONTEXT);
  const scores = await scoreWithJev(unscored, context, g.name);
  scores?.forEach((s, i) => jevScores.set(unscored[i]!.message_id, s));
}

/** 该不该现在处理这个群（规则见文件头） */
function isDue(g: PendingGroup, t: number): boolean {
  if (g.pending >= MIN_PENDING || t - g.oldest >= MAX_WAIT_MS) return true;
  const rows = pendingRows(g.group_id);
  const candidates = rows.filter((m) => !isNoise(m.text));
  if (candidates.some((m) => !jevScores.has(m.message_id))) return false; // 没打上分：按老规则等
  const scored = candidates.map((m) => ({ m, s: jevScores.get(m.message_id)! }));
  const urgent = scored.filter((x) => x.s >= JEV_URGENT_AT);
  if (urgent.length) {
    const newest = Math.max(...rows.map((r) => r.created_at));
    const firstUrgent = Math.min(...urgent.map((x) => (x.m as Row).created_at));
    return t - newest >= QUIET_MS || t - firstUrgent >= URGENT_MAX_WAIT_MS;
  }
  const uncertain = scored.filter((x) => x.s >= JEV_DROP_BELOW);
  if (uncertain.length === 0) return true; // 全是噪声 / 确定不是：不调 LLM，立刻收尾
  return t - Math.min(...uncertain.map((x) => (x.m as Row).created_at)) >= UNCERTAIN_WAIT_MS;
}

// ---------- 并发控制 ----------

/** 正在处理的群 → 该批次；同一个群不并发（上下文和已有事件依赖上一批的结果） */
const inflight = new Map<string, Promise<number>>();
let slots = GROUP_CONCURRENCY;
const waiters: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (slots > 0) slots--;
  else await new Promise<void>((r) => waiters.push(r));
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else slots++;
  }
}

/** 开始处理某群的一批；该群已在处理中就返回那一批 */
function launch(g: PendingGroup): Promise<number> {
  const running = inflight.get(g.group_id);
  if (running) return running;
  const p = withSlot(() => processBatch(g))
    .catch((e) => {
      console.warn(`[pipeline] 群 ${g.group_id} 调度出错：`, e);
      return 0;
    })
    .finally(() => inflight.delete(g.group_id));
  inflight.set(g.group_id, p);
  return p;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- 入口 ----------

let ticking = false;

/**
 * 调度器的一次检查：给攒着的消息打 Jev 分，把该处理的群交出去（不等别的群的批次跑完）。
 * 返回的 Promise 在本次交出去的批次都处理完后才 resolve。now 只给测试用。
 */
export async function tick(now?: number): Promise<void> {
  if (ticking || Date.now() < llmRetryAt) return; // 上一次分诊还没完 / AI 刚连不上，先歇一会
  ticking = true;
  let launched: Promise<number>[] = [];
  try {
    if (jevScores.size > SCORE_CACHE_MAX) jevScores.clear(); // 删群 / 重置演示留下的残余，清掉重打即可
    const t = () => now ?? Date.now();
    const idle = pendingGroups().filter((g) => !inflight.has(g.group_id));
    // 已经到点的不用分诊（批次里会补打分）；其余的先分诊再判断
    const early = idle.filter((g) => !(g.pending >= MIN_PENDING || t() - g.oldest >= MAX_WAIT_MS));
    if (early.length && jevAvailable()) await mapLimit(early, GROUP_CONCURRENCY, triage);
    launched = idle.filter((g) => isDue(g, t())).map(launch);
  } catch (e) {
    console.warn('[pipeline] 调度出错：', e);
  } finally {
    ticking = false;
  }
  await Promise.all(launched);
}

/** 立即把所有群处理完（不看阈值，不看 AI 重试等待）；有批次在跑就等它结束。不抛异常。 */
export async function runPipelineNow(): Promise<void> {
  try {
    for (;;) {
      await Promise.all(inflight.values());
      const groups = pendingGroups();
      if (groups.length === 0) return;
      const done = await Promise.all(groups.map(launch));
      if (done.every((n) => n === 0)) return; // 置不上 processed 就别空转
    }
  } catch (e) {
    console.warn('[pipeline] 立即处理出错：', e);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/** 测试用：清掉「AI 连不上，歇一会」的状态和 Jev 分数缓存 */
export function resetLlmRetry(): void {
  llmRetryAt = 0;
  jevScores.clear();
  lastTriage.clear();
}

// 换号（修复计划第一节）：Jev 分数、分诊时间、重试等待、统计计数都是旧号的，清掉；
// 在飞的批次由 processBatch 里的 dbGeneration 守卫拦下，不会写进新号库。
onAccountSwitch(() => {
  llmRetryAt = 0;
  jevScores.clear();
  lastTriage.clear();
  resetPipelineStats();
});

export function startScheduler(): void {
  timer ??= setInterval(() => void tick(), TICK_MS);
}

export function stopScheduler(): void {
  clearInterval(timer);
  timer = undefined;
}
