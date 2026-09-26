import type { Message, MessageSource } from '../types.js';

/**
 * 消息入库（同步）。群不存在则登记（enabled=1）；群名变了更新；
 * 群 enabled=0 的消息直接丢弃不入库；INSERT OR IGNORE 按 message_id 去重。
 * 实现见 B2。
 */
export function ingestMessages(_msgs: Message[], _source: MessageSource): { inserted: number } {
  return { inserted: 0 };
}

/** A 在 get_group_list 后调用刷新群名。实现见 B2。 */
export function upsertGroup(_group_id: string, _name: string, _adapter: MessageSource): void {
  // 空实现
}
