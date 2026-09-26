// 历史补齐（FR-2 + FR-16）。主人是 A（分工 A6）。
// 对 enabled=1 且 adapter='onebot' 的群逐个翻页 get_group_msg_history：
//   第一页不带 message_seq（拉最新 200 条）；之后每页 message_seq = 上一页最早一条的 message_id。
// 停止条件（任一满足）：本页最早一条早于 now−days / 本页没有新 id / 本页为空或报错 / 已翻 30 页。
// 只入库 sent_at ≥ now−days 的消息；入库去重同时看 messages 和 message_seen（见 ingest/index.ts）。
import { db } from '../db/index.js';
import { ingestMessages } from './index.js';
import { callAction, getGroupNameCached, isMentionOther, toMessage } from '../napcat/onebot.js';
import type { Message } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 30;

let inflight: Promise<{ groups: number; messages: number }> | null = null;

/**
 * 历史补齐。days=往前补多少天（1 / 7 / 30，缺省 7 保持登录自动补齐的行为）。
 * 一个群失败不影响其他群；同一时刻只允许一个 sync 在跑（第二次调用返回正在跑的那个）。
 * 入库完就返回，不等流水线整理完（前端用 health.pending 看进度）。
 */
export function syncHistory(days = 7): Promise<{ groups: number; messages: number }> {
  if (inflight !== null) return inflight;
  inflight = doSync(days).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doSync(days: number): Promise<{ groups: number; messages: number }> {
  let rows: Array<{ group_id?: unknown }> = [];
  try {
    rows = db
      .prepare("SELECT group_id FROM groups WHERE enabled = 1 AND adapter = 'onebot'")
      .all() as Array<{ group_id?: unknown }>;
  } catch {
    return { groups: 0, messages: 0 }; // 表还没建 / 库不可用：0/0
  }

  const since = Date.now() - days * DAY_MS;
  let groups = 0;
  let messages = 0;

  for (const row of rows) {
    const groupId = String(row?.group_id ?? '');
    if (groupId === '' || groupId.startsWith('demo-')) continue;
    try {
      const msgs = await fetchGroupHistory(groupId, since);
      const { inserted } = ingestMessages(msgs, 'history');
      groups += 1;
      messages += inserted;
    } catch {
      // 一个群失败不影响其他群（分工 A6）
    }
  }
  return { groups, messages };
}

/**
 * 翻页拉一个群的历史（消息体大，不整页入库，逐页转换）。
 * 单页失败/抛错 = 停止该群翻页，已翻到的照样返回（部分补齐也好过没有）。
 */
async function fetchGroupHistory(groupId: string, since: number): Promise<Message[]> {
  const name = () => getGroupNameCached(groupId);
  const out: Message[] = [];
  const seenIds = new Set<string>();
  let seq: number | undefined; // 上一页最早一条的 message_id

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, unknown> = { group_id: Number(groupId), count: PAGE_SIZE };
    if (seq !== undefined) params.message_seq = seq;

    let items: unknown[];
    try {
      // NapCat 找不到锚点时抛「消息 X 不存在」→ 停在这一页
      items = extractMessages(await callAction<unknown>('get_group_msg_history', params));
    } catch {
      break;
    }
    if (items.length === 0) break;

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

    // 任一停止条件：已到窗口外 / 全是旧 id（锚点重复返回了）/ 拿不到锚点
    if (anchorAt < since || newIds === 0 || anchorSeq === undefined) break;
    seq = anchorSeq;
  }
  return out;
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
