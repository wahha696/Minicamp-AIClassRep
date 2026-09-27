// 消息入库（FR-1.4/1.5）。群不存在则登记（enabled=1）；群名变了更新；
// 群 enabled=0 的消息直接丢弃不入库；按 message_id 去重——同时查 messages 和 message_seen
// （message_seen 是清理原始消息时留下的 id，防止 30 天刷新把已处理过的旧消息再整理一遍），
// 以及 event_sources——老版本清理不写 message_seen，升级后第一次 30 天刷新会把那些消息拉回来，
// 已经变成过事件的那部分靠 event_sources 认出来，不再重复建事件。
import { db } from '../db/index.js';
import type { Message, MessageSource } from '../types.js';

interface GroupRow {
  name: string;
  enabled: number;
}

function loadGroups(): Map<string, GroupRow> {
  const rows = db.prepare('SELECT group_id, name, enabled FROM groups').all() as unknown as ({
    group_id: string;
  } & GroupRow)[];
  const map = new Map<string, GroupRow>();
  for (const row of rows) map.set(row.group_id, { name: row.name, enabled: row.enabled });
  return map;
}

/** 整批入库。返回真正新插入的条数（被去重、被丢弃的不算）。 */
export function ingestMessages(msgs: Message[], source: MessageSource): { inserted: number } {
  const now = Date.now();
  const insertGroup = db.prepare(
    'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
  );
  const renameGroup = db.prepare('UPDATE groups SET name = ? WHERE group_id = ?');
  const insertMessage = db.prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  );
  const seenBefore = db.prepare(
    `SELECT 1 AS ok FROM message_seen WHERE message_id = ?
     UNION ALL SELECT 1 FROM event_sources WHERE message_id = ? LIMIT 1`,
  );

  let inserted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const groups = loadGroups();
    for (const msg of msgs) {
      const known = groups.get(msg.group_id);
      if (known === undefined) {
        // 新群：自动登记，默认开启
        insertGroup.run(msg.group_id, msg.group_name, source, now);
        groups.set(msg.group_id, { name: msg.group_name, enabled: 1 });
      } else {
        if (known.enabled === 0) continue; // 关掉的群，消息直接丢
        // 空群名不覆盖已有群名（历史补齐等来源可能拿不到群名）
        if (msg.group_name !== '' && known.name !== msg.group_name) {
          renameGroup.run(msg.group_name, msg.group_id);
          known.name = msg.group_name;
        }
      }

      // 处理过的 id 跳过（清理已删掉原文但记得处理过 / 已经是某个事件的来源）
      if (seenBefore.get(msg.message_id, msg.message_id) !== undefined) continue;

      const res = insertMessage.run(
        msg.message_id,
        msg.group_id,
        msg.sender_name,
        msg.text,
        msg.sent_at,
        source,
        now,
      );
      if (res.changes > 0) inserted++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { inserted };
}

/** A 在 get_group_list 后调用刷新群名。已存在的群只改名，不动 enabled。 */
export function upsertGroup(group_id: string, name: string, adapter: MessageSource): void {
  const existing = db.prepare('SELECT name FROM groups WHERE group_id = ?').get(group_id) as
    | { name: string }
    | undefined;
  if (existing === undefined) {
    db.prepare(
      'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
    ).run(group_id, name, adapter, Date.now());
    return;
  }
  if (name !== '' && existing.name !== name) {
    db.prepare('UPDATE groups SET name = ? WHERE group_id = ?').run(name, group_id);
  }
}
