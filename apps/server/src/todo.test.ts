// isTodo 全分支（FR-15）。前端 lib/todo.ts 有一份同款拷贝，两边用同一组用例。
import { describe, expect, it } from 'vitest';
import { isTodo } from './todo.js';

const T = Date.parse('2026-09-27T14:00+08:00');

const ev = (over: Partial<Parameters<typeof isTodo>[0]> = {}) => ({
  status: 'active' as const,
  type: 'exam' as const,
  start_at: null,
  end_at: null,
  deadline_at: null,
  ...over,
});

describe('isTodo', () => {
  it.each([
    ['完全没时间的事件', ev()],
    ['只有开始的作业', ev({ type: 'assignment', start_at: T })],
    ['只有结束的作业', ev({ type: 'assignment', end_at: T })],
    ['pending_confirm 的没时间事件', ev({ status: 'pending_confirm' })],
  ])('是待办：%s', (_, e) => {
    expect(isTodo(e)).toBe(true);
  });

  it.each([
    ['有截止时间的作业', ev({ type: 'assignment', deadline_at: T })],
    ['有截止时间的没时间事件', ev({ deadline_at: T })],
    ['有开始的非作业', ev({ start_at: T })],
    ['有结束的非作业', ev({ end_at: T })],
    ['有开始和截止的作业', ev({ type: 'assignment', start_at: T, deadline_at: T })],
    ['已完成的没时间事件', ev({ status: 'done' })],
    ['已取消的没时间事件', ev({ status: 'cancelled' })],
  ])('不是待办：%s', (_, e) => {
    expect(isTodo(e)).toBe(false);
  });
});
