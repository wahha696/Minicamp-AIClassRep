// 事件类型的固定配色与中文名（FR-7.3，D-前端.md「设计要求」）。今日/本周/详情共用。
import type { EventStatus, EventType } from '../api/types';

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

/** 后端将来多出新类型时不崩，按「其他」显示 */
export function typeMeta(type: string) {
  return TYPE_META[type as EventType] ?? TYPE_META.other;
}
