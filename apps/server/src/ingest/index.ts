// 消息入库（FR-1.4/1.5）。群不存在则登记（enabled=1）；群名变了更新；
// 群 enabled=0 的消息直接丢弃不入库；INSERT OR IGNORE 按 message_id 去重。
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
        if (known.name !== msg.group_name) {
          renameGroup.run(msg.group_name, msg.group_id);
          known.name = msg.group_name;
        }
      }

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
  if (existing.name !== name) {
    db.prepare('UPDATE groups SET name = ? WHERE group_id = ?').run(name, group_id);
  }
}
