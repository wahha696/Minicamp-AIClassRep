// 事件类型的固定配色与中文名（FR-7.3，D-前端.md「设计要求」）。今日/本周/详情共用。
import type { EventDTO, EventStatus, EventType } from '../api/types';

export const TYPE_META: Record<EventType, { label: string; color: string }> = {
  exam: { label: '考试', color: '#ef4444' },
  assignment: { label: '作业', color: '#f97316' },
  meeting: { label: '会议', color: '#3b82f6' },
  activity: { label: '活动', color: '#22c55e' },
  announcement: { label: '通知', color: '#6b7280' },
  other: { label: '其他', color: '#9ca3af' },
};

export const STATUS_TEXT: Record<EventStatus, string> = {
  active: '进行中',
  pending_confirm: '待确认',
  done: '已完成',
  cancelled: '已取消',
};

/**
 * 有变更记录（被改期/改地点/取消过）→ 卡片显示「已按最新通知更新」。
 * 列表接口不带 history；version 只在流水线写 event_history 时 +1（手动 PATCH 不改 version），所以 version>1 即有变更记录。
 */
export function isUpdated(e: Pick<EventDTO, 'version'>): boolean {
  return e.version > 1;
}

/** 后端将来多出新类型时不崩，按「其他」显示 */
export function typeMeta(type: string) {
  return TYPE_META[type as EventType] ?? TYPE_META.other;
}
