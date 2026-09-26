import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { PresenceTracker, registerPresence } from './presence.js';

function tracker() {
  let t = 0;
  const tr = new PresenceTracker({ byeGraceMs: 15, staleMs: 150, startupGraceMs: 180, now: () => t });
  return { tr, at: (v: number) => (t = v) };
}

describe('PresenceTracker', () => {
  it('启动后一直没有页面：过了启动宽限才退出', () => {
    const { tr, at } = tracker();
    at(179);
    expect(tr.shouldExit()).toBe(false);
    at(180);
    expect(tr.shouldExit()).toBe(true);
  });

  it('有页面在线不退出；最后一个页面说再见后等宽限期再退出', () => {
    const { tr, at } = tracker();
    tr.ping('a');
    tr.ping('b');
    at(500);
    tr.ping('a');
    tr.ping('b');
    tr.bye('a');
    at(520);
    expect(tr.shouldExit()).toBe(false); // b 还在
    tr.bye('b');
    at(530);
    expect(tr.shouldExit()).toBe(false);
    at(535);
    expect(tr.shouldExit()).toBe(true);
  });

  it('刷新页面：再见后很快又报到，不退出', () => {
    const { tr, at } = tracker();
    tr.ping('a');
    tr.bye('a');
    at(5);
    tr.ping('a2');
    at(100);
    expect(tr.shouldExit()).toBe(false);
  });

  it('页面长时间没报到算掉线', () => {
    const { tr, at } = tracker();
    at(100);
    tr.ping('a');
    at(249);
    expect(tr.online()).toBe(1);
    at(251);
    expect(tr.online()).toBe(0);
    expect(tr.shouldExit()).toBe(true);
  });
});

describe('registerPresence 路由', () => {
  it('报到 / 再见 / 没页面后调 onIdle', async () => {
    vi.useFakeTimers();
    const app = new Hono();
    const onIdle = vi.fn();
    const stop = registerPresence(app, onIdle, { byeGraceMs: 1000, startupGraceMs: 60_000, checkEveryMs: 100 });

    expect((await app.request('/api/presence?id=abc')).status).toBe(200);
    expect((await app.request('/api/presence')).status).toBe(400);
    await app.request('/api/presence/bye?id=abc', { method: 'POST' });
    vi.advanceTimersByTime(500);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stop();
    vi.useRealTimers();
  });
});
