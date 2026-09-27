import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOCK_DIR } from '../paths.js';
import { isNoise } from './filter.js';

describe('isNoise', () => {
  it.each([
    '收到', '收到！', '收到～', '收到收到', '好的', '好滴', 'ok', 'OK', 'Ok~',
    '嗯', '嗯嗯嗯', '哈哈哈哈哈', '666', '+1', '谢谢', '知道了', '1', '111', '啊啊啊', '草',
    '？？？', '???', '好的谢谢', '[at] 收到',
    '[图片]', '[表情][表情]', '[语音]', '  ', '👍', '👍👍👍👍', '❤️', '。。。',
    '约！', '去哪吃', '冲冲冲', '好看！', '啊这', '笑死', '在吗',
  ])('噪声：%j', (text) => {
    expect(isNoise(text)).toBe(true);
  });

  it.each([
    '明天下午两点在 A301 随堂小测',
    '[at] 小测改到周五下午两点，教室改 A203',
    '[图片] 本周五 23:59 前交实验报告',
    '今晚8点', '明天交', '周五', '几点', '截止', 'ddl', '3楼', 'A203',
    '考多久啊', '收到，那明天几点', '好的，周五见', '老师说考到第四章',
    '晚上约饭吗', '二食堂三楼麻辣香锅',
    // 成熟度评估 §12 复现：短变更/取消消息必须留给 LLM 结合上下文判断
    '取消了', '不交了', '改线上', '改到周五', '不上了', '换教室了', '推迟一周',
    '明天不考了', '不用交了', '考试取消了', '改成线上', '活动暂停', '补考',
  ])('保留：%j', (text) => {
    expect(isNoise(text)).toBe(false);
  });
});

/** 每个剧本里必须保留的真通知（子串）。新增剧本时要在这里登记。 */
const NOTICES: Record<string, string[]> = {
  reschedule: ['明天下午两点在 A301', '小测改到周五', '明天不考了，改周五'],
  cancel: ['迎新茶话会，有零食', '茶话会取消了'],
  assignment: ['牛顿环实验报告提交', '迈克尔逊', '第二章 5、7、9', '满意度问卷', '要附上原始数据'],
  meeting: ['今晚 8 点在 3 号楼 201', '提醒一下，今晚 8 点'],
  noisy: ['选课确认', '年级大会'],
  'similar-exams': ['高数期中考试定在', '线代期中考试定在', '线代期中的考场改到', '高数不变'],
};

describe('data/mock 仿真剧本', () => {
  const scenarios = readdirSync(MOCK_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: basename(f, '.json'),
      messages: (JSON.parse(readFileSync(join(MOCK_DIR, f), 'utf8')) as { messages: { text: string }[] })
        .messages,
    }));

  it('总过滤率 ≥ 50%', () => {
    const all = scenarios.flatMap((s) => s.messages);
    const filtered = all.filter((m) => isNoise(m.text)).length;
    expect(all.length).toBeGreaterThanOrEqual(300);
    expect(filtered / all.length).toBeGreaterThanOrEqual(0.5);
  });

  it.each(scenarios.map((s) => [s.name, s] as const))('%s：真通知一条都不被过滤', (name, s) => {
    const notices = NOTICES[name];
    expect(notices, `请在 NOTICES 里登记 ${name} 的真通知`).toBeDefined();
    for (const key of notices!) {
      const msg = s.messages.find((m) => m.text.includes(key));
      expect(msg, `找不到真通知「${key}」`).toBeDefined();
      expect(isNoise(msg!.text), msg!.text).toBe(false);
    }
  });
});
