// 消息入库（FR-1.4/1.5）。群不存在则登记（onebot/history 来源默认关闭——D6：
// 账号所在全部群的消息都发给 AI 是隐私与费用问题，要监听的群由用户在群管理里勾选；
// demo/import 是用户明确动作，仍默认开启）；群名变了更新；
// 群 enabled=0 的消息直接丢弃不入库；按 (group_id, message_id) 去重——同时查 messages 和
// message_seen（message_seen 是清理原始消息时留下的 id，防止 30 天刷新把已处理过的旧消息再整理一遍），
// 以及 event_sources——老版本清理不写 message_seen，升级后第一次 30 天刷新会把那些消息拉回来，
// 已经变成过事件的那部分靠 event_sources 认出来，不再重复建事件。
import { beginTx, commitTx, db, rollbackTx } from '../db/index.js';
import type { Message, MessageSource } from '../types.js';

interface GroupRow {
  name: string;
  enabled: number;
}

/** 新发现的群默认是否开启（D6）：QQ 来源默认关闭，等用户在群管理里勾选；demo/import 默认开启 */
function defaultEnabled(source: MessageSource): number {
  return source === 'onebot' || source === 'history' || source === 'forward' ? 0 : 1;
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
    'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const renameGroup = db.prepare('UPDATE groups SET name = ? WHERE group_id = ?');
  const insertMessage = db.prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  );
  // 去重（schema v2 复合主键）：同群同 id 才算重复。
  // message_seen 里 group_id='' 的是 v1 老库迁来的记录（当时不记群），同样认；
  // event_sources 经 events 拿到群号，老版本清理没写 message_seen 的也能认出来。
  const seenBefore = db.prepare(
    `SELECT 1 AS ok FROM message_seen WHERE message_id = ? AND group_id IN (?, '')
     UNION ALL
     SELECT 1 FROM event_sources es JOIN events ev ON ev.id = es.event_id
       WHERE es.message_id = ? AND ev.group_id = ?
     LIMIT 1`,
  );

  let inserted = 0;
  beginTx();
  try {
    const groups = loadGroups();
    for (const msg of msgs) {
      const known = groups.get(msg.group_id);
      if (known === undefined) {
        const en = defaultEnabled(source);
        insertGroup.run(msg.group_id, msg.group_name, en, source, now);
        groups.set(msg.group_id, { name: msg.group_name, enabled: en });
        if (en === 0) continue; // 新登记但默认关闭的群（D6），消息同样直接丢
      } else {
        if (known.enabled === 0) continue; // 关掉的群，消息直接丢
        // 空群名不覆盖已有群名（历史补齐等来源可能拿不到群名）
        if (msg.group_name !== '' && known.name !== msg.group_name) {
          renameGroup.run(msg.group_name, msg.group_id);
          known.name = msg.group_name;
        }
      }

      // 处理过的 id 跳过（清理已删掉原文但记得处理过 / 已经是某个事件的来源）
      if (seenBefore.get(msg.message_id, msg.group_id, msg.message_id, msg.group_id) !== undefined) continue;

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
    commitTx();
  } catch (err) {
    rollbackTx();
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
      'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(group_id, name, defaultEnabled(adapter), adapter, Date.now());
    return;
  }
  if (name !== '' && existing.name !== name) {
    db.prepare('UPDATE groups SET name = ? WHERE group_id = ?').run(name, group_id);
  }
}
