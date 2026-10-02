// 历史补齐（FR-2 + FR-16）。主人是 A（分工 A6）。
// 对 enabled=1 且 adapter='onebot' 的群逐个翻页 get_group_msg_history：
//   第一页不带 message_seq（拉最新 200 条）；之后每页 message_seq = 上一页最早一条的 message_id，
//   且必须带 reverse_order=true——不带时 NapCat 会返回锚点「之后」的消息（向前），
//   翻一圈全是旧 id 被误判成「已补完」，实际只拉到一页（真机验证：21h → 修正后回到 13 天）。
// 停止条件（任一满足）：本页最早一条早于 now−days / 本页没有新 id / 本页为空或报错 / 已翻 30 页。
// 只入库 sent_at ≥ now−days 的消息；入库去重同时看 messages 和 message_seen（见 ingest/index.ts）。
import { accountDataState, accountEpoch } from '../accounts.js';
import { db, dbGeneration, onAccountSwitch } from '../db/index.js';
import { ingestMessages } from './index.js';
import { callAction, getGroupNameCached, isMentionOther, segmentsToText, toMessage } from '../napcat/onebot.js';
import type { Message } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 60;

/** R03：一群一次补齐的结果（写进 group_sync，前端能报告「哪群补到哪 / 为什么没补全」） */
type GroupFetch = {
  msgs: Message[];
  oldestAt: number | null; // 本次拉到的最早一条 sent_at
  complete: boolean; // true = 窗口内已补到尽头；false = 被页数上限/翻页报错截断
  reason: 'ok' | 'page_cap' | 'page_error';
};

type SyncResult = { groups: number; messages: number; failures: number };
type SyncAccountContext = { generation: number; accountEpoch: string; captureEpoch: number };
let captureEpoch = 0;
/** Cancel old page requests before QQ is handed back; late replies cannot write into a resumed session. */
export function cancelHistorySync(): void { captureEpoch++; inflight = null; }
let inflight: { days: number; context: SyncAccountContext; promise: Promise<SyncResult> } | null = null;
const EMPTY_RESULT: SyncResult = { groups: 0, messages: 0, failures: 0 };

/**
 * 历史补齐不在调度器的静默队列里，网络请求跨切号后必须自己核对账号上下文。
 * 只看 dbGeneration 不够：目标账号库挂载失败时旧连接与 generation 都会保留，
 * 但 OneBot 会话已经属于新账号；此时继续请求会把新账号响应写进旧账号库。
 */
function captureSyncAccountContext(): SyncAccountContext | null {
  if (accountDataState() !== 'ready') return null;
  return { generation: dbGeneration(), accountEpoch: accountEpoch(), captureEpoch };
}

function syncAccountIsCurrent(context: SyncAccountContext): boolean {
  return (
    accountDataState() === 'ready' &&
    context.captureEpoch === captureEpoch &&
    dbGeneration() === context.generation &&
    accountEpoch() === context.accountEpoch
  );
}

// 换号（修复计划第一节）：正在跑的同步是旧号的，让它自然结束（doSync 里有换代守卫，不会写进新库）；
// inflight 标记清掉，新号点「同步历史」重新拉
onAccountSwitch(() => {
  inflight = null;
});

/**
 * 历史补齐。days=往前补多少天（1 / 7 / 30，缺省 7 保持登录自动补齐的行为）。
 * 一个群失败不影响其他群；同一时刻只有一个 sync 在跑：
 *   新请求的天数 ≤ 正在跑的 → 直接复用；更大 → 等它跑完再按新天数补一次（已入库的会被去重），两次结果相加。
 * 入库完就返回，不等流水线整理完（前端用 health.pending 看进度）。
 */
export function syncHistory(days = 7): Promise<SyncResult> {
  const context = captureSyncAccountContext();
  if (context === null) return Promise.resolve(EMPTY_RESULT);
  const running =
    inflight?.context.generation === context.generation &&
    inflight.context.accountEpoch === context.accountEpoch
      ? inflight
      : null;
  if (running !== null && days <= running.days) return running.promise;
  const promise: Promise<SyncResult> = (async () => {
    const first = running ? await running.promise.catch(() => EMPTY_RESULT) : null;
    // 更大窗口排在旧任务后面时，换号会让后半程直接作废，不能在新账号上重新起跑。
    if (!syncAccountIsCurrent(context)) return first ?? EMPTY_RESULT;
    const r = await doSync(days, context);
    return first
      ? {
          groups: Math.max(first.groups, r.groups),
          messages: first.messages + r.messages,
          failures: first.failures + r.failures,
        }
      : r;
  })().finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { days, context, promise };
  return promise;
}

async function doSync(days: number, context: SyncAccountContext): Promise<SyncResult> {
  if (!syncAccountIsCurrent(context)) return EMPTY_RESULT;
  let rows: Array<{ group_id?: unknown }> = [];
  try {
    rows = db
      .prepare("SELECT group_id FROM groups WHERE enabled = 1 AND adapter = 'onebot'")
      .all() as Array<{ group_id?: unknown }>;
  } catch {
    return { groups: 0, messages: 0, failures: 0 }; // 表还没建 / 库不可用：0/0
  }

  const since = Date.now() - days * DAY_MS;
  const now = Date.now();
  let groups = 0;
  let messages = 0;
  let failures = 0;

  for (const row of rows) {
    if (!syncAccountIsCurrent(context)) break; // 换号或挂库失败：拉来的是旧上下文历史，停
    const groupId = String(row?.group_id ?? '');
    if (groupId === '' || groupId.startsWith('demo-')) continue;
    try {
      const r = await fetchGroupHistory(groupId, since, context);
      if (!syncAccountIsCurrent(context)) break;
      // 精华消息独立于漫游窗口（班委常把通知设精华）：顺带拉一遍，一起去重入库
      const ess = await fetchGroupEssence(groupId, since, context);
      if (!syncAccountIsCurrent(context)) break;
      const { inserted } = ingestMessages([...r.msgs, ...ess], 'history');
      groups += 1;
      messages += inserted;
      if (!r.complete) failures += 1;
      writeGroupSync(groupId, now, r.oldestAt, r.complete, r.reason, context);
    } catch {
      // 一个群失败不影响其他群（分工 A6）；但失败要留痕，前端能提示「这群没补上」
      if (!syncAccountIsCurrent(context)) break;
      failures += 1;
      writeGroupSync(groupId, now, null, false, 'error', context);
    }
  }
  return { groups, messages, failures };
}

/** R03：把每群补齐结果写进 group_sync（同群覆盖上一轮的记录） */
function writeGroupSync(
  groupId: string,
  at: number,
  oldestAt: number | null,
  complete: boolean,
  reason: string,
  context: SyncAccountContext,
): void {
  if (!syncAccountIsCurrent(context)) return;
  try {
    db.prepare(
      `INSERT INTO group_sync (group_id, last_sync_at, oldest_at, complete, reason) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         oldest_at = MIN(COALESCE(oldest_at, excluded.oldest_at), COALESCE(excluded.oldest_at, oldest_at)),
         complete = excluded.complete,
         reason = excluded.reason`,
    ).run(groupId, at, oldestAt, complete ? 1 : 0, reason);
  } catch (e) {
    console.warn(`[history] group_sync 写入失败（${groupId}）：`, e);
  }
}

/**
 * 翻页拉一个群的历史（消息体大，不整页入库，逐页转换）。
 * 单页失败/抛错 = 停止该群翻页，已翻到的照样返回（部分补齐也好过没有）。
 */
async function fetchGroupHistory(groupId: string, since: number, context: SyncAccountContext): Promise<GroupFetch> {
  const name = () => getGroupNameCached(groupId);
  const out: Message[] = [];
  const seenIds = new Set<string>();
  let seq: number | undefined; // 上一页最早一条的 message_id
  let oldestAt: number | null = null;
  let complete = false;
  let reason: GroupFetch['reason'] = 'ok';

  for (let page = 0; page < MAX_PAGES; page++) {
    if (!syncAccountIsCurrent(context)) break;
    const params: Record<string, unknown> = { group_id: Number(groupId), count: PAGE_SIZE };
    if (seq !== undefined) {
      params.message_seq = seq;
      params.reverse_order = true; // NapCat：不传返回锚点之后的消息，向后翻页必须传 true
    }

    let items: unknown[] | undefined;
    // 单页失败重试一次（群多时限流/抖动常见）：第二次再失败才算 page_error
    for (let attempt = 0; attempt < 2 && items === undefined; attempt++) {
      if (!syncAccountIsCurrent(context)) break;
      try {
        items = extractMessages(await callAction<unknown>('get_group_msg_history', params));
        if (!syncAccountIsCurrent(context)) break;
      } catch (e) {
        if (!syncAccountIsCurrent(context)) break;
        // NapCat 找不到锚点时抛「消息 X 不存在」= 服务端也没有更早的记录，算补全；
        // 其它错误（断网/超时/限流）无法确认窗口内是否还有更早消息，按没补全报
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('不存在')) {
          complete = true;
          items = undefined;
          break;
        }
        if (attempt === 1) {
          reason = 'page_error';
          break;
        }
        await new Promise((r) => setTimeout(r, 800)); // 轻退避再试一次
        if (!syncAccountIsCurrent(context)) break;
      }
    }
    if (!syncAccountIsCurrent(context)) break;
    if (complete && items === undefined) break; // 「不存在」到头
    if (items === undefined) break; // 重试后仍失败
    if (items.length === 0) {
      complete = true; // 空页 = 服务端也没更早的记录了，窗口内已补全
      break;
    }

    // 本页最早一条（按消息里的 time 秒级时间戳）做下一页锚点
    let anchorSeq: number | undefined;
    let anchorAt = Number.POSITIVE_INFINITY;
    let newIds = 0;
    for (const item of items) {
      const raw = item as Record<string, unknown>;
      const sentAt = Number(raw.time) * 1000;
      if (Number.isFinite(sentAt) && sentAt < anchorAt) {
        anchorAt = sentAt;
        const id = Number(raw.message_id);
        if (Number.isFinite(id)) anchorSeq = id;
      }
      const mid = String(raw.message_id ?? '');
      if (mid !== '' && !seenIds.has(mid)) {
        seenIds.add(mid);
        newIds++;
      }

      if (isMentionOther(item)) continue; // @规则：只 @了别人的消息忽略（与实时消息一致）
      const m = toMessage(withEventFields(item, groupId), name);
      if (m !== null && m.sent_at >= since) out.push(m);
    }

    if (oldestAt === null || anchorAt < oldestAt) oldestAt = anchorAt === Number.POSITIVE_INFINITY ? oldestAt : anchorAt;

    // 任一停止条件：已到窗口外（补全）/ 全是旧 id（锚点重复，服务端到头了）/ 拿不到锚点
    if (anchorAt < since || newIds === 0) {
      complete = true;
      break;
    }
    if (anchorSeq === undefined) {
      complete = false;
      reason = 'page_error'; // 翻不下去却还有新数据：按截断报
      break;
    }
    seq = anchorSeq;
  }
  if (!complete && reason === 'ok') reason = 'page_cap'; // 跑满 MAX_PAGES 还没到头
  return { msgs: out, oldestAt, complete, reason };
}

/**
 * 群精华消息。NapCat get_essence_msg_list 返回真实 message_id，
 * 和实时流/漫游拉到的同一条天然去重；失败返回空（精华是补充通道，不拖垮主同步）。
 */
async function fetchGroupEssence(groupId: string, since: number, context: SyncAccountContext): Promise<Message[]> {
  if (!syncAccountIsCurrent(context)) return [];
  try {
    const data = await callAction<unknown>('get_essence_msg_list', { group_id: Number(groupId) });
    if (!syncAccountIsCurrent(context)) return [];
    const items = Array.isArray(data) ? data : [];
    const out: Message[] = [];
    for (const it of items) {
      if (it === null || typeof it !== 'object' || Array.isArray(it)) continue;
      const o = it as Record<string, unknown>;
      const timeSec = Number(o.sender_time ?? o.time ?? 0);
      const sentAt = timeSec * 1000;
      if (!Number.isFinite(sentAt) || sentAt <= 0 || sentAt < since) continue;
      const mid = String(o.message_id ?? '');
      if (mid === '') continue;
      const segs = o.content ?? o.message;
      const text = typeof segs === 'string' ? segs : segmentsToText(segs);
      if (text === '') continue;
      out.push({
        message_id: mid,
        group_id: groupId,
        group_name: getGroupNameCached(groupId),
        sender_name: String(o.sender_nick ?? o.sender_name ?? '未知'),
        text,
        sent_at: sentAt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** NapCat 返回形态兜底：data 本身是数组，或 { messages: [...] } */
function extractMessages(resp: unknown): unknown[] {
  if (Array.isArray(resp)) return resp;
  if (resp !== null && typeof resp === 'object') {
    const m = (resp as Record<string, unknown>).messages;
    if (Array.isArray(m)) return m;
  }
  return [];
}

/** 历史消息条目没有 post_type/message_type，补齐成群消息事件再走统一的 toMessage */
function withEventFields(item: unknown, groupId: string): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
  const obj: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  if (typeof obj.post_type !== 'string' || obj.post_type === '') obj.post_type = 'message';
  if (obj.message_type === undefined || obj.message_type === '') obj.message_type = 'group';
  if (obj.group_id === undefined || obj.group_id === null || obj.group_id === '') obj.group_id = groupId;
  return obj;
}
