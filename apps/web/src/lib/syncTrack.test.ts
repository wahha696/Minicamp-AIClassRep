import { describe, expect, it } from 'vitest';
import { TRACK_MAX_FAILS, TRACK_MAX_MS, syncLeft, trackStep } from './syncTrack';

const T0 = 1_000_000;
const track = (over = {}) => ({ total: 20, base: 5, startedAt: T0, fails: 0, ...over });

describe('补拉后的整理进度', () => {
  it('只能报告全局积压，不用基线相减猜本次任务进度', () => {
    expect(syncLeft(track(), 25)).toBe(25);
    expect(syncLeft(track(), 12)).toBe(12);
    expect(syncLeft(track(), 40)).toBe(40);
    expect(syncLeft(track(), 3)).toBe(3);
  });

  it('只有全局待整理为零才结束，不因旧积压消化而提前宣布完成', () => {
    expect(trackStep(track({ base: 100 }), { pending: 20, llm: 'ok' }, T0 + 3000)).toEqual({ kind: 'progress', left: 20 });
    expect(trackStep(track(), { pending: 0, llm: 'ok' }, T0 + 3000)).toEqual({ kind: 'done' });
  });

  it('还有剩余 → 显示剩余数', () => {
    expect(trackStep(track(), { pending: 12, llm: 'ok' }, T0 + 3000)).toEqual({ kind: 'progress', left: 12 });
  });

  it('没配 AI → 停止跟踪，不再一直转圈', () => {
    expect(trackStep(track(), { pending: 25, llm: 'unconfigured' }, T0 + 3000)).toMatchObject({ kind: 'stop' });
  });

  it('超过上限时间 → 停止跟踪', () => {
    expect(trackStep(track(), { pending: 25, llm: 'ok' }, T0 + TRACK_MAX_MS)).toMatchObject({ kind: 'stop' });
  });

  it('读不到 health：偶尔失败沿用上次数字，连续失败到上限才停', () => {
    expect(trackStep(track({ fails: 1 }), null, T0)).toEqual({ kind: 'progress', left: -1 });
    expect(trackStep(track({ fails: TRACK_MAX_FAILS }), null, T0)).toMatchObject({ kind: 'stop' });
  });
});
