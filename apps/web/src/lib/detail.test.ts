// D4 自测：来源原文高亮、变更记录中文化。
import { describe, expect, it } from 'vitest';
import { fieldValueText, highlightSegments, historyLines } from './detail';

const sh = (s: string) => Date.parse(`${s}+08:00`);
const NOW = sh('2026-09-30T10:00:00'); // 周三

const hits = (text: string) => highlightSegments(text).filter((s) => s.hit).map((s) => s.text);

describe('highlightSegments', () => {
  it('拼回去等于原文', () => {
    const t = '[at] 小测改到周五下午两点，教室改 A203';
    expect(highlightSegments(t).map((s) => s.text).join('')).toBe(t);
  });

  it('标出时间词和教室号', () => {
    expect(hits('[at] 小测改到周五下午两点，教室改 A203')).toEqual(['周五', '下午两点', 'A203']);
    expect(hits('@全体成员 明天下午两点在 A301 随堂小测')).toEqual(['明天', '下午两点', 'A301']);
    expect(hits('第三章习题 P87 1~12 今晚 23:59 前交')).toEqual(['今晚', '23:59']);
    expect(hits('明晚 7 点 B105 班委例会')).toEqual(['明晚', 'B105']);
    expect(hits('下周三 9:30 主楼 305 期中考试')).toEqual(['下周三', '9:30', '主楼 305']);
    expect(hits('10月8日 学生活动中心 201')).toEqual(['10月8日', '学生活动中心 201']);
  });

  it('没有命中时整段原样', () => {
    expect(highlightSegments('收到')).toEqual([{ text: '收到', hit: false }]);
    expect(highlightSegments('')).toEqual([]);
  });
});

describe('变更记录', () => {
  it('字段值翻译', () => {
    expect(fieldValueText('start_at', sh('2026-10-02T14:00:00'), NOW)).toBe('后天 14:00');
    expect(fieldValueText('status', 'cancelled')).toBe('已取消');
    expect(fieldValueText('type', 'exam')).toBe('考试');
    expect(fieldValueText('location', null)).toBe('无');
    expect(fieldValueText('confidence', 0.935)).toBe('94%');
  });

  it('渲染成「版本 · 时间 · 字段：旧 → 新」', () => {
    const lines = historyLines(
      [
        {
          version: 2,
          changed_fields: {
            start_at: { from: sh('2026-09-29T14:00:00'), to: sh('2026-10-02T14:00:00') },
            location: { from: 'A301', to: 'A203' },
            weird_field: { from: 1, to: 2 },
          },
          source_message_id: 'm2',
          changed_at: sh('2026-10-01T14:03:00'),
        },
      ],
      NOW,
    );
    expect(lines).toEqual([
      {
        version: 2,
        when: '10/1 14:03',
        changes: [
          { field: 'start_at', label: '时间', from: '昨天 14:00', to: '后天 14:00' },
          { field: 'location', label: '地点', from: 'A301', to: 'A203' },
          { field: 'weird_field', label: 'weird_field', from: '1', to: '2' },
        ],
      },
    ]);
  });
});
