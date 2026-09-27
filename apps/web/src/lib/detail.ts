// 详情抽屉（D4）的纯函数：来源原文高亮、变更记录渲染。
import type { EventType, HistoryDTO, Level } from '../api/types';
import { LEVEL_LABEL, STATUS_TEXT, TYPE_META } from './eventMeta';
import { formatWhen, hhmm } from './time';

// ===== 原文高亮：时间词、地点（简单正则，宁可少标不乱标）

const TIME_WORDS = [
  '(?:今天|明天|后天|昨天|今晚|明晚|今早|明早)',
  '(?:本|这|下下?)(?:周|星期|礼拜)[一二三四五六日天]?',
  '(?:周|星期|礼拜)[一二三四五六日天]',
  '\\d{1,2}月\\d{1,2}[日号]',
  '(?:上午|下午|晚上|中午|早上|凌晨|傍晚)?\\d{1,2}[:：]\\d{2}',
  '(?:上午|下午|晚上|中午|早上|凌晨|傍晚)?(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})点(?:半|\\d{1,2}分?)?',
  '(?:上午|下午|晚上|中午|早上|凌晨|傍晚)',
];
const PLACES = [
  // 「教学楼 B105」「主楼 305」「学生活动中心 201」
  '[\\u4e00-\\u9fa5]{0,4}(?:楼|馆|中心|教室)\\s?[A-Za-z]?\\d{2,4}',
  // 「A203」「B-105」
  '(?<![A-Za-z0-9])[A-Za-z]{1,2}-?\\d{3,4}(?!\\d)',
];
const HIGHLIGHT_RE = new RegExp([...PLACES, ...TIME_WORDS].join('|'), 'g');

export interface Segment {
  text: string;
  hit: boolean;
}

export function highlightSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(HIGHLIGHT_RE)) {
    if (!m[0]) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

// ===== 变更记录

export const FIELD_TEXT: Record<string, string> = {
  title: '标题',
  type: '类型',
  description: '说明',
  start_at: '时间',
  end_at: '结束时间',
  deadline_at: '截止时间',
  location: '地点',
  action_required: '要求',
  status: '状态',
  confidence: '置信度',
  level: '危机等级',
};

const TIME_FIELDS = new Set(['start_at', 'end_at', 'deadline_at']);

export function fieldValueText(field: string, value: unknown, now = Date.now()): string {
  if (value === null || value === undefined || value === '') return '无';
  if (TIME_FIELDS.has(field) && typeof value === 'number') return formatWhen(value, now);
  if (field === 'type') return TYPE_META[value as EventType]?.label ?? String(value);
  if (field === 'status') return STATUS_TEXT[value as keyof typeof STATUS_TEXT] ?? String(value);
  if (field === 'confidence' && typeof value === 'number') return `${Math.round(value * 100)}%`;
  if (field === 'level') return LEVEL_LABEL[value as Level] ?? String(value);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export interface HistoryChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

export interface HistoryLine {
  version: number;
  when: string; // 「10/1 14:03」
  manual: boolean; // 用户手动调级（不升 version，和同版本的流水线记录共用版本号）
  changes: HistoryChange[];
}

/** 手动调级写的 history：没有来源消息、只改了 level */
function isManualLevel(h: HistoryDTO): boolean {
  const fields = Object.keys(h.changed_fields);
  return h.source_message_id === null && fields.length === 1 && fields[0] === 'level';
}

/** 「10/1 14:03」（上海时间） */
export function monthDayTime(ts: number): string {
  const d = new Date(ts + 8 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm(ts)}`;
}

export function historyLines(history: HistoryDTO[], now = Date.now()): HistoryLine[] {
  return history.map((h) => ({
    version: h.version,
    when: monthDayTime(h.changed_at),
    manual: isManualLevel(h),
    changes: Object.entries(h.changed_fields).map(([field, c]) => ({
      field,
      label: FIELD_TEXT[field] ?? field,
      from: fieldValueText(field, c?.from, now),
      to: fieldValueText(field, c?.to, now),
    })),
  }));
}
