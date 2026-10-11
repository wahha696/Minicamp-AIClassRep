import { expect, it } from 'vitest';
import { syncLeft, trackStep } from './syncTrack';
const track = { total: 20, base: 5, startedAt: 0, fails: 0 };
it('全局待整理不能冒充本次任务完成量', () => { expect(syncLeft(track, 40)).toBe(40); expect(syncLeft(track, -1)).toBe(0); });
it('有积压时持续等待，数小时后不硬截止', () => {
  expect(trackStep(track, { pending: 12, llm: 'ok' }, 12 * 60 * 60_000)).toEqual({ kind: 'progress', left: 12 });
  expect(trackStep(track, { pending: 0, llm: 'ok' }, 0)).toEqual({ kind: 'done' });
});
it('连接故障连续发生时仍重连，保留上次数字', () => {
  expect(trackStep({ ...track, fails: 100 }, null, 0)).toEqual({ kind: 'progress', left: -1, message: '暂时看不到整理进度，正在重连后台' });
});
it('没有AI配置时说明原因，补回的消息不丢弃', () => {
  expect(trackStep(track, { pending: 25, llm: 'unconfigured' }, 0)).toEqual({ kind: 'stop', message: '还没配置 AI，补回的消息暂不整理' });
});
