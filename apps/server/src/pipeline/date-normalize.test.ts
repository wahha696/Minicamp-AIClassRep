import { describe, expect, it } from 'vitest';
import { completeTimes, resolveWhen } from './date-normalize.js';
import { fmtShanghai } from './extract.js';

// 验证集取自考卷（eval.ts 的 EXPECT + data/mock 的真实表达）：这些正是学生模型答错的用例，
// now 也取自 eval 运行时的"当前时间"，所以期望值就是考卷答案本身。
const NOW = Date.parse('2026-09-29T20:34:00+08:00');

describe('resolveWhen：考卷里的相对时间表达', () => {
  const cases: [string, string, 'deadline' | 'start'][] = [
    ['本周五 23:59 前交', '2026-10-02 23:59', 'deadline'],
    ['明天上午 10 点前在教务系统确认', '2026-09-30 10:00', 'deadline'],
    ['下周三下午两点年级大会', '2026-10-07 14:00', 'start'],
    ['下周二上午 8 点考高数', '2026-10-06 08:00', 'start'],
    ['下周四上午 10 点线代考试', '2026-10-08 10:00', 'start'],
    ['改到本周五下午两点，教室换成 A203', '2026-10-02 14:00', 'start'],
    ['今晚 8 点 3 号楼 201 班委会', '2026-09-29 20:00', 'start'],
    ['本周日晚上 22:00 前提交问卷', '2026-10-04 22:00', 'deadline'],
    ['下周三晚上十点前交第二章习题', '2026-10-07 22:00', 'deadline'],
    ['下周一交迈克尔逊预习报告', '2026-10-05 23:59', 'deadline'],
  ];
  for (const [text, want, kind] of cases) {
    it(`「${text}」→ ${want}`, () => {
      const r = resolveWhen(text, NOW, kind);
      expect(r).not.toBeNull();
      expect(fmtShanghai(r!.at).startsWith(want)).toBe(true);
    });
  }

  it('跨周边界：周日深夜的「本周一」仍属本周（与 calendar() 同口径）', () => {
    const sunday = Date.parse('2026-10-04T23:50:00+08:00');
    expect(fmtShanghai(resolveWhen('本周一交的作业还没改', sunday, 'start')!.at).startsWith('2026-09-28')).toBe(true);
    expect(fmtShanghai(resolveWhen('下周一上午九点年级大会', sunday)!.at).startsWith('2026-10-05 09:00')).toBe(true);
    expect(fmtShanghai(resolveWhen('明天上午九点年级大会', sunday)!.at).startsWith('2026-10-05 09:00')).toBe(true);
  });

  it('闲聊里的弱信号不算强信号（否则会把 chatter 写成事件时间）', () => {
    for (const t of ['第三章我一点没看', '四点左右', '食堂今天有炸鸡', '今天高数作业是哪几页来着']) {
      const r = resolveWhen(t, NOW);
      expect(r?.strong ?? false, t).toBe(false);
    }
  });
});

describe('completeTimes：两种策略', () => {
  const msgs = [
    { message_id: 'm1', text: '这周实验报告记得交哈，本周五 23:59 前传到学习通' },
    { message_id: 'm2', text: '线代考试改到下周四上午 10 点，5 号楼 301' },
  ];

  it('fill：只补 null，不覆盖模型已给的（哪怕是错的）值', () => {
    const wrong = { type: 'exam', start_at: Date.parse('2026-09-30T10:00:00+08:00'), source_message_ids: ['m2'] };
    const { events, filled, corrected } = completeTimes([wrong], msgs, NOW, 'fill');
    expect(filled).toBe(0);
    expect(corrected).toBe(0);
    expect(events[0]!.start_at).toBe(wrong.start_at);
  });

  it('prefer：能解析出强信号就以代码为准（模型给错的日期被纠正）', () => {
    const rows = [
      { type: 'assignment', deadline_at: null, source_message_ids: ['m1'] },
      { type: 'exam', start_at: Date.parse('2026-09-30T10:00:00+08:00'), source_message_ids: ['m2'] },
    ];
    const { events, filled, corrected } = completeTimes(rows, msgs, NOW, 'prefer');
    expect(filled).toBe(1);
    expect(corrected).toBe(1);
    expect(fmtShanghai(events[0]!.deadline_at!).startsWith('2026-10-02 23:59')).toBe(true);
    expect(fmtShanghai(events[1]!.start_at!).startsWith('2026-10-08 10:00')).toBe(true);
  });

  it('来源消息是闲聊时不写时间（留 null 交人工）', () => {
    const rows = [{ type: 'assignment', deadline_at: null, source_message_ids: ['m3'] }];
    const { events, filled } = completeTimes(rows, [{ message_id: 'm3', text: '第三章我一点没看' }], NOW, 'prefer');
    expect(filled).toBe(0);
    expect(events[0]!.deadline_at ?? null).toBeNull();
  });
});
