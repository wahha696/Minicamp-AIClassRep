// 事件类型的固定配色与中文名（FR-7.3，D-前端.md「设计要求」）。今日/本周/详情共用。
// 危机等级：类型定色相、等级定深浅（FR-12）。bg=卡片底色、bar=左侧色条、text=强调文字。
// Tailwind 4 只认完整字面量类名，所以样式表全部写死，不做字符串拼接。
import type { EventDTO, EventStatus, EventType, Level } from '../api/types';

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

export const LEVEL_LABEL: Record<Level, string> = { 1: '低', 2: '中', 3: '高', 4: '紧急' };

export interface LevelStyle {
  bg: string;   // 卡片/格子底色
  bar: string;  // 左侧色条
  text: string; // 强调文字（标签、等级角标）
}

// 6 种类型 × 4 档深浅；等级越高底色越深、色条越重
const LEVEL_STYLE: Record<EventType, Record<Level, LevelStyle>> = {
  exam: {
    1: { bg: 'bg-red-50', bar: 'bg-red-300', text: 'text-red-600' },
    2: { bg: 'bg-red-100', bar: 'bg-red-400', text: 'text-red-700' },
    3: { bg: 'bg-red-200', bar: 'bg-red-600', text: 'text-red-800' },
    4: { bg: 'bg-red-200', bar: 'bg-red-700', text: 'text-red-900' },
  },
  assignment: {
    1: { bg: 'bg-orange-50', bar: 'bg-orange-300', text: 'text-orange-600' },
    2: { bg: 'bg-orange-100', bar: 'bg-orange-400', text: 'text-orange-700' },
    3: { bg: 'bg-orange-200', bar: 'bg-orange-600', text: 'text-orange-800' },
    4: { bg: 'bg-orange-200', bar: 'bg-orange-700', text: 'text-orange-900' },
  },
  meeting: {
    1: { bg: 'bg-blue-50', bar: 'bg-blue-300', text: 'text-blue-600' },
    2: { bg: 'bg-blue-100', bar: 'bg-blue-400', text: 'text-blue-700' },
    3: { bg: 'bg-blue-200', bar: 'bg-blue-600', text: 'text-blue-800' },
    4: { bg: 'bg-blue-200', bar: 'bg-blue-700', text: 'text-blue-900' },
  },
  activity: {
    1: { bg: 'bg-green-50', bar: 'bg-green-300', text: 'text-green-600' },
    2: { bg: 'bg-green-100', bar: 'bg-green-400', text: 'text-green-700' },
    3: { bg: 'bg-green-200', bar: 'bg-green-600', text: 'text-green-800' },
    4: { bg: 'bg-green-200', bar: 'bg-green-700', text: 'text-green-900' },
  },
  announcement: {
    1: { bg: 'bg-gray-50', bar: 'bg-gray-300', text: 'text-gray-600' },
    2: { bg: 'bg-gray-100', bar: 'bg-gray-400', text: 'text-gray-700' },
    3: { bg: 'bg-gray-200', bar: 'bg-gray-600', text: 'text-gray-800' },
    4: { bg: 'bg-gray-200', bar: 'bg-gray-700', text: 'text-gray-900' },
  },
  other: {
    1: { bg: 'bg-slate-50', bar: 'bg-slate-300', text: 'text-slate-600' },
    2: { bg: 'bg-slate-100', bar: 'bg-slate-400', text: 'text-slate-700' },
    3: { bg: 'bg-slate-200', bar: 'bg-slate-600', text: 'text-slate-800' },
    4: { bg: 'bg-slate-200', bar: 'bg-slate-700', text: 'text-slate-900' },
  },
};

/** 类型定色相、等级定深浅；未知类型/越界等级按「其他·中」兜底 */
export function levelStyle(type: string, level: number): LevelStyle {
  const t = type in LEVEL_STYLE ? (type as EventType) : 'other';
  const lv: Level = level >= 1 && level <= 4 ? (level as Level) : 2;
  return LEVEL_STYLE[t][lv];
}
