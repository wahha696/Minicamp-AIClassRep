// 回收站一行的显示文字
import { describe, expect, it } from 'vitest';
import type { EventDTO, TrashItemDTO } from '../api/types';
import { expiresText, trashLine } from './trash';

const sh = (s: string) => Date.parse(`${s}+08:00`);
const NOW = sh('2026-09-30T10:00:00'); // 周三
const DAY = 86_400_000;

function ev(p: Partial<EventDTO> = {}): EventDTO {
  return {
    id: 1,
    group_id: 'g1',
    group_name: '高数(2)班',
    type: 'exam',
    title: '高数小测',
    description: '',
    start_at: sh('2026-10-02T14:00:00'),
    end_at: null,
    deadline_at: null,
    location: 'A203',
    action_required: null,
    status: 'cancelled',
    confidence: 0.9,
    level: 2,
    level_locked: false,
    version: 1,
    created_at: NOW - DAY,
    updated_at: NOW,
    ...p,
  };
}

function item(p: Partial<TrashItemDTO>): TrashItemDTO {
  return {
    id: 'cancel-1',
    kind: 'cancelled',
    by: 'manual',
    event: ev(),
    changes: { status: { from: 'active', to: 'cancelled' } },
    source_text: null,
    at: NOW,
    expires_at: NOW + 30 * DAY,
    ...p,
  };
}

describe('trashLine', () => {
  it('自己取消的：标题 + 时间地点群名 + 恢复', () => {
    expect(trashLine(item({}), NOW)).toEqual({
      title: '高数小测',
      badge: '你取消的',
      meta: '后天 14:00 · A203 · 高数(2)班',
      changes: [],
      action: '恢复',
      expires: '30 天后清除',
    });
  });

  it('群里取消的', () => {
    expect(trashLine(item({ by: 'group', source_text: '取消了' }), NOW).badge).toBe('群里取消');
  });

  it('群里改期改地点：列出旧值 → 新值（开始时间改了就不单列结束时间），按钮「恢复原样」', () => {
    const line = trashLine(
      item({
        id: 'change-5',
        kind: 'changed',
        by: 'group',
        event: ev({ status: 'active', start_at: sh('2026-10-03T14:00:00'), location: 'A203' }),
        changes: {
          start_at: { from: sh('2026-10-02T14:00:00'), to: sh('2026-10-03T14:00:00') },
          end_at: { from: null, to: null },
          location: { from: 'A301', to: 'A203' },
        },
      }),
      NOW,
    );
    expect(line.badge).toBe('群里改期、改地点');
    expect(line.action).toBe('恢复原样');
    expect(line.changes).toEqual([
      { field: 'start_at', label: '时间', from: '后天 14:00', to: '周六 14:00' },
      { field: 'location', label: '地点', from: 'A301', to: 'A203' },
    ]);
  });

  it('改名的显示旧名字', () => {
    const line = trashLine(
      item({ kind: 'changed', by: 'group', event: ev({ title: '新名字' }), changes: { title: { from: '旧名字', to: '新名字' } } }),
      NOW,
    );
    expect(line.title).toBe('旧名字');
    expect(line.badge).toBe('群里改名');
  });
});

describe('expiresText', () => {
  it('向上取整天数，最后一天显示「今天清除」', () => {
    expect(expiresText(NOW + 30 * DAY, NOW)).toBe('30 天后清除');
    expect(expiresText(NOW + 1.5 * DAY, NOW)).toBe('2 天后清除');
    expect(expiresText(NOW + 3_600_000, NOW)).toBe('今天清除');
    expect(expiresText(NOW - 1, NOW)).toBe('今天清除');
  });
});
