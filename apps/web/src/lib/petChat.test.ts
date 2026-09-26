import { describe, expect, it } from 'vitest';
import type { EventDTO } from '../api/types';
import { eventTimeText } from './time';
import { groupListText, petReply, QUICK_QUESTIONS } from './petChat';

const MIN = 60_000;
const H = 3_600_000;
const NOW = 1_000_000_000_000; // 固定「现在」，让断言可确定

const ev = (over: Partial<EventDTO> = {}): EventDTO => ({
  id: 1, group_id: 'g', group_name: 'g', type: 'other', title: '高数小测', description: '',
  start_at: null, end_at: null, deadline_at: null, location: null, action_required: null,
  status: 'active', confidence: 1, version: 1, created_at: 0, updated_at: 0, ...over,
});
const ctx = (over: Partial<Parameters<typeof petReply>[1]> = {}) => ({
  now: NOW, events: [] as EventDTO[], summary: '今天没有待办，轻松一天', ...over,
});

describe('对话框：动作类', () => {
  it('「同步一下」→ sync 动作', () => {
    expect(petReply('帮我同步一下', ctx())).toMatchObject({ action: 'sync' });
  });
  it('「走两步」→ stroll 动作', () => {
    expect(petReply('走两步', ctx())).toMatchObject({ action: 'stroll', text: '来喽~' });
  });
  it('「打开本周」→ 跳周视图', () => {
    expect(petReply('打开本周', ctx())).toMatchObject({ action: 'nav-week' });
    expect(petReply('这周怎么安排', ctx())).toMatchObject({ action: 'nav-week' });
  });
  it('「去群管理」→ 跳群管理页', () => {
    expect(petReply('去群管理页', ctx())).toMatchObject({ action: 'nav-groups' });
  });
});

describe('对话框：日程问答', () => {
  it('今天有事 → 列出（带时间）；全办完/没事各有一句', () => {
    const events = [
      ev({ title: '高数小测', start_at: NOW + 5 * MIN, end_at: NOW + 45 * MIN }),
      ev({ title: '班会', start_at: NOW + 3 * H }),
    ];
    expect(petReply('今天有什么事', { ...ctx(), events }).text)
      .toBe(`今天 2 件事：「高数小测」${eventTimeText(events[0], NOW).text}；「班会」${eventTimeText(events[1], NOW).text}`);
    expect(petReply('今天有什么事', { ...ctx(), events: [ev({ status: 'done' })], summary: undefined }).text)
      .toBe('今天的事都办完啦，干得漂亮！');
    expect(petReply('今天有什么事', ctx()).text).toBe('今天没有待办，轻松一天');
  });

  it('接下来 → 最近一件 + 倒计时；没有就说休息', () => {
    const events = [ev({ title: '高数小测', start_at: NOW + 25 * MIN })];
    const a = petReply('接下来做什么', { ...ctx(), events });
    expect(a.text).toContain('「高数小测」');
    expect(a.text).toContain('还有 25 分钟');
    expect(petReply('接下来做什么', ctx()).text).toBe('今天没有接下来的安排了，好好休息~');
  });

  it('截止 → 列出带「截止」字样；没有则提示去本周页', () => {
    const events = [ev({ title: '实验报告', deadline_at: NOW + 2 * H })];
    const a = petReply('最近截止', { ...ctx(), events });
    expect(a.text).toContain('「实验报告」');
    expect(a.text).toContain('截止');
    expect(petReply('最近截止', ctx()).text).toContain('本周');
  });

  it('看看群 → needGroups；拿到数据后用 groupListText 格式化', () => {
    expect(petReply('看看群', ctx())).toMatchObject({ needGroups: true });
    expect(groupListText([])).toContain('还没有监听任何群');
    expect(groupListText([
      { group_id: '1', name: '高数(2)班', enabled: true, message_count: 3, event_count: 1 },
      { group_id: '2', name: '英语群', enabled: false, message_count: 0, event_count: 0 },
    ])).toBe('监听中的群 1/2 个：高数(2)班、英语群。要增删监听去「群管理」页~');
  });
});

describe('对话框：状态与闲聊', () => {
  it('连接问题按状态回答，且永不出现 NapCat', () => {
    const states = ['qq_conflict', 'error', 'kicked', 'online', 'waiting_qr', 'reconnecting', 'starting'] as const;
    for (const s of states) {
      const a = petReply('连接正常吗', { ...ctx(), connect: s });
      expect(a.text.toLowerCase()).not.toContain('napcat');
      expect(a.text.length).toBeGreaterThan(0);
    }
  });

  it('打招呼带时段问候；问候语里也不出现 NapCat', () => {
    const texts = [petReply('你好', ctx()).text, petReply('hi', ctx()).text];
    expect(texts.join('')).not.toContain('napcat');
  });

  it('几点 → 回当前时间（HH:mm）', () => {
    expect(petReply('现在几点了', ctx()).text).toMatch(/现在是 \d{2}:\d{2}/);
  });

  it('问功能 → 帮助文案；不知道的 → 引导性兜底', () => {
    expect(petReply('你能做什么', ctx()).text).toContain('今天有什么事');
    expect(petReply('给我讲个笑话吧', ctx()).text).toContain('我还在学');
  });

  it('快捷问题全部有回答', () => {
    for (const q of QUICK_QUESTIONS) {
      expect(petReply(q, ctx()).text.length).toBeGreaterThan(0);
    }
  });

  it('空输入不崩', () => {
    expect(petReply('  ', ctx()).text.length).toBeGreaterThan(0);
  });

  it('matched 标记：命中规则为 true，只有兜底是 false（LLM 路由依据，PET-12）', () => {
    expect(petReply('同步一下', ctx()).matched).toBe(true);
    expect(petReply('给我讲个笑话吧', ctx()).matched).toBe(false);
  });
});
