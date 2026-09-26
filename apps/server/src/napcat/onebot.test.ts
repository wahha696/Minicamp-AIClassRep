// A4 验收：vitest 测 segmentsToText 和事件 → Message 的转换（用假 JSON，分工 A4）。
import { describe, expect, it } from 'vitest';
import { getGroupNameCached, segmentsToText, toMessage } from './onebot.js';

describe('segmentsToText（FR-1.3 消息段 → 纯文本）', () => {
  it('text 段保留原文', () => {
    expect(segmentsToText([{ type: 'text', data: { text: '明天下午两点小测' } }])).toBe('明天下午两点小测');
  });

  it('at 段（含 @全体成员 qq=all）统一转 [at]', () => {
    expect(segmentsToText([{ type: 'at', data: { qq: 'all' } }])).toBe('[at]');
    expect(segmentsToText([{ type: 'at', data: { qq: '10001' } }])).toBe('[at]');
  });

  it('各类非文本段转对应占位符', () => {
    expect(segmentsToText([{ type: 'image', data: { file: 'a.png' } }])).toBe('[图片]');
    expect(segmentsToText([{ type: 'face', data: { id: '1' } }])).toBe('[表情]');
    expect(segmentsToText([{ type: 'mface', data: {} }])).toBe('[表情]');
    expect(segmentsToText([{ type: 'json', data: { data: '{}' } }])).toBe('[卡片]');
    expect(segmentsToText([{ type: 'forward', data: { id: 'x' } }])).toBe('[转发]');
    expect(segmentsToText([{ type: 'file', data: { name: 'a.zip' } }])).toBe('[文件]');
    expect(segmentsToText([{ type: 'record', data: {} }])).toBe('[语音]');
    expect(segmentsToText([{ type: 'video', data: {} }])).toBe('[视频]');
  });

  it('reply 段转为空（不占文本）', () => {
    expect(segmentsToText([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '好的' } }])).toBe('好的');
  });

  it('混合消息按序拼接', () => {
    expect(segmentsToText([
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' 小测改到周五 ' } },
      { type: 'image', data: {} },
      { type: 'face', data: {} },
    ])).toBe('[at] 小测改到周五 [图片][表情]');
  });

  it('未知类型与畸形段不抛异常，逐段兜底', () => {
    expect(segmentsToText([{ type: 'whatever', data: {} }])).toBe('[消息]');
    // null/42/'str' → [消息]；{data:{}} 无 type → [消息]；{type:'text'} 无文本 → 空
    expect(segmentsToText([null, 42, 'str', { data: {} }, { type: 'text' }])).toBe('[消息][消息][消息][消息]');
    expect(segmentsToText(undefined)).toBe('[消息]');
    expect(segmentsToText(null)).toBe('[消息]');
  });

  it('字符串格式的 message 直接返回原文（容错）', () => {
    expect(segmentsToText('纯文本消息')).toBe('纯文本消息');
  });
});

describe('toMessage（事件 → 统一 Message）', () => {
  const base = {
    post_type: 'message',
    message_type: 'group',
    message_id: 12345,
    group_id: 987654321,
    time: 1727300000, // OneBot 秒级时间戳
    sender: { card: '', nickname: '张老师' },
    message: [{ type: 'text', data: { text: '明天下午两点在 A301 随堂小测' } }],
  };

  it('普通群消息：id 转字符串、time 秒转毫秒、无群名缓存时用 String(group_id)', () => {
    expect(toMessage(base)).toEqual({
      message_id: '12345',
      group_id: '987654321',
      group_name: '987654321',
      sender_name: '张老师',
      text: '明天下午两点在 A301 随堂小测',
      sent_at: 1_727_300_000_000,
    });
  });

  it('message_sent（自己发的消息，FR-1.2）同样转换', () => {
    expect(toMessage({ ...base, post_type: 'message_sent', sender: { card: '', nickname: '我' } })?.sender_name).toBe('我');
  });

  it('sender_name：card 优先于 nickname，都空时「未知」', () => {
    expect(toMessage({ ...base, sender: { card: '班长', nickname: '真名' } })?.sender_name).toBe('班长');
    expect(toMessage({ ...base, sender: {} })?.sender_name).toBe('未知');
  });

  it('非群消息 / 其他 post_type / 畸形输入 → null，不抛', () => {
    expect(toMessage({ ...base, message_type: 'private' })).toBeNull();
    expect(toMessage({ ...base, post_type: 'notice' })).toBeNull();
    expect(toMessage(null)).toBeNull();
    expect(toMessage('not an object')).toBeNull();
    expect(toMessage(undefined)).toBeNull();
  });

  it('group_name 优先用注入的解析器（对应 get_group_list 缓存）', () => {
    expect(toMessage(base, () => '高数(2)班')?.group_name).toBe('高数(2)班');
  });

  it('time 缺失/非法时不崩，sent_at 为 0', () => {
    expect(toMessage({ ...base, time: undefined })?.sent_at).toBe(0);
    expect(toMessage({ ...base, time: 'not-a-number' })?.sent_at).toBe(0);
  });

  it('getGroupNameCached：无缓存返回原 id', () => {
    expect(getGroupNameCached('111')).toBe('111');
  });
});
