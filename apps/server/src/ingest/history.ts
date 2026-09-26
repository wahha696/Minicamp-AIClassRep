// 历史补齐（FR-2）。主人是 A（分工 A6）。
// 对 enabled=1 且 adapter='onebot' 的群逐个 get_group_msg_history，只保留 7 天内的，转 Message 后入库。
import { db } from '../db/index.js';
import { env } from '../env.js';
import { ingestMessages } from './index.js';
import { callAction, getGroupNameCached, isMentionOther, toMessage } from '../napcat/onebot.js';
import type { Message } from '../types.js';

let inflight: Promise<{ groups: number; messages: number }> | null = null;

/**
 * 历史补齐（FR-2）。每次进入 online 由 onebot.ts 自动调用；POST /api/sync 也走这里。
 * 只保留 RAW_MSG_TTL_DAYS（默认 7）天内的消息（架构.md D12）；一个群失败不影响其他群；
 * 同一时刻只允许一个 sync 在跑（第二次调用直接返回正在跑的那个 Promise）。
 */
export function syncHistory(): Promise<{ groups: number; messages: number }> {
  if (inflight !== null) return inflight;
  inflight = doSync().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doSync(): Promise<{ groups: number; messages: number }> {
  let rows: Array<{ group_id?: unknown }> = [];
  try {
    rows = db
      .prepare("SELECT group_id FROM groups WHERE enabled = 1 AND adapter = 'onebot'")
      .all() as Array<{ group_id?: unknown }>;
  } catch {
    return { groups: 0, messages: 0 }; // 表还没建 / 库不可用：0/0
  }

  const since = Date.now() - env.RAW_MSG_TTL_DAYS * 24 * 60 * 60 * 1000;
  let groups = 0;
  let messages = 0;

  for (const row of rows) {
    const groupId = String(row?.group_id ?? '');
    if (groupId === '' || groupId.startsWith('demo-')) continue;
    try {
      // get_group_msg_history：count=200（需求 FR-2.1；NapCat 实测可用，需求文档 §8）
      const resp = await callAction<unknown>('get_group_msg_history', { group_id: Number(groupId), count: 200 });
      const msgs: Message[] = [];
      for (const item of extractMessages(resp)) {
        if (isMentionOther(item)) continue; // @规则：只 @了别人的消息忽略（与实时消息一致）
        const m = toMessage(withEventFields(item, groupId), () => getGroupNameCached(groupId));
        if (m !== null && m.sent_at >= since) msgs.push(m);
      }
      const { inserted } = ingestMessages(msgs, 'history');
      groups += 1;
      messages += inserted;
    } catch {
      // 一个群失败不影响其他群（分工 A6）
    }
  }
  return { groups, messages };
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
