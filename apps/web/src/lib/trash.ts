// 设置页「回收站」一栏的纯函数：把 TrashItemDTO 变成一行要显示的内容。
import type { TrashItemDTO } from '../api/types';
import { FIELD_TEXT, fieldValueText } from './detail';
import { eventTimeText } from './time';

const DAY = 86_400_000;

export interface TrashChange {
  field: string;
  label: string;
  /** 改动前（恢复后会变回这个） */
  from: string;
  /** 现在的 */
  to: string;
}

export interface TrashLine {
  title: string;
  /** 「你取消的」「群里取消」「群里改期」「群里改期、改地点」… */
  badge: string;
  /** 事件现在的时间 · 地点 · 群名 */
  meta: string;
  /** 改动（kind=changed 才有） */
  changes: TrashChange[];
  /** 恢复按钮上的字 */
  action: string;
  /** 「3 天后清除」「今天清除」 */
  expires: string;
}

const CHANGE_WORD: Record<string, string> = {
  start_at: '改期',
  end_at: '改期',
  deadline_at: '改截止',
  location: '改地点',
  title: '改名',
};

function changedBadge(fields: string[]): string {
  const words = [...new Set(fields.map((f) => CHANGE_WORD[f]).filter((w): w is string => w !== undefined))];
  return `群里${words.length ? words.join('、') : '改动'}`;
}

export function expiresText(expiresAt: number, now = Date.now()): string {
  const days = Math.ceil((expiresAt - now) / DAY);
  return days <= 1 ? '今天清除' : `${days} 天后清除`;
}

export function trashLine(item: TrashItemDTO, now = Date.now()): TrashLine {
  const e = item.event;
  const meta = [eventTimeText(e, now).text, e.location, e.group_name].filter(Boolean).join(' · ');
  const expires = expiresText(item.expires_at, now);
  if (item.kind === 'cancelled') {
    return {
      title: e.title,
      badge: item.by === 'manual' ? '你取消的' : '群里取消',
      meta,
      changes: [],
      action: '恢复',
      expires,
    };
  }
  const fields = Object.keys(item.changes);
  // 开始时间一起改了时，结束时间不单独列（恢复时照样一起改回）
  const shown = 'start_at' in item.changes ? fields.filter((f) => f !== 'end_at') : fields;
  // 标题被改过时显示改之前的名字，方便认出是哪件事
  const oldTitle = item.changes['title']?.from;
  return {
    title: typeof oldTitle === 'string' && oldTitle ? oldTitle : e.title,
    badge: changedBadge(fields),
    meta,
    changes: shown.map((f) => ({
      field: f,
      label: FIELD_TEXT[f] ?? f,
      from: fieldValueText(f, item.changes[f]?.from, now),
      to: fieldValueText(f, item.changes[f]?.to, now),
    })),
    action: '恢复原样',
    expires,
  };
}
