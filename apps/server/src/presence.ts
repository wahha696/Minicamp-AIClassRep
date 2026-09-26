// 「关掉网页就自动退出」（只在后台模式 AUTO_EXIT=1 下启用，scripts/dev.mjs --background 会设置）。
// 每个打开的网页定时 GET /api/presence?id=xxx 报到；关页面时 sendBeacon POST /api/presence/bye?id=xxx。
// 没有任何页面在线一段时间后调 onIdle()（index.ts 里就是正常退出流程：停采集端、关库）。
import type { Hono } from 'hono';

export interface PresenceOptions {
  /** 最后一个页面说再见后，再等这么久没人回来就退出（给刷新页面留时间） */
  byeGraceMs?: number;
  /** 页面多久没报到算掉线（浏览器后台标签页的定时器可能被限到 1 分钟一次，所以要留够） */
  staleMs?: number;
  /** 启动后多久还没有任何页面打开，也退出（避免后台一直空跑） */
  startupGraceMs?: number;
  /** 检查间隔 */
  checkEveryMs?: number;
  now?: () => number;
}

/** 纯逻辑，方便测试：记录每个页面最后报到时间，判断现在是否该退出 */
export class PresenceTracker {
  private clients = new Map<string, number>();
  private lastByeAt: number | null = null;
  private readonly startedAt: number;

  constructor(
    private readonly opts: Required<Omit<PresenceOptions, 'checkEveryMs' | 'now'>> & { now: () => number },
  ) {
    this.startedAt = opts.now();
  }

  ping(id: string): void {
    this.clients.set(id, this.opts.now());
    this.lastByeAt = null;
  }

  bye(id: string): void {
    this.clients.delete(id);
    this.lastByeAt = this.opts.now();
  }

  /** 在线页面数（顺便清掉超时没报到的） */
  online(): number {
    const now = this.opts.now();
    for (const [id, at] of this.clients) {
      if (now - at > this.opts.staleMs) this.clients.delete(id);
    }
    return this.clients.size;
  }

  shouldExit(): boolean {
    if (this.online() > 0) return false;
    const now = this.opts.now();
    if (this.lastByeAt !== null) return now - this.lastByeAt >= this.opts.byeGraceMs;
    // 没人说再见：要么从来没人打开过，要么页面都超时了（浏览器崩了 / 电脑睡眠）
    return now - this.startedAt >= this.opts.startupGraceMs;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 注册报到接口并开始定时检查；返回 stop()（测试用） */
export function registerPresence(app: Hono, onIdle: () => void, options: PresenceOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const tracker = new PresenceTracker({
    byeGraceMs: options.byeGraceMs ?? 15_000,
    staleMs: options.staleMs ?? 150_000,
    startupGraceMs: options.startupGraceMs ?? 180_000,
    now,
  });

  app.get('/api/presence', (c) => {
    const id = c.req.query('id') ?? '';
    if (!ID_RE.test(id)) return c.json({ error: '缺少页面 id' }, 400);
    tracker.ping(id);
    return c.json({ ok: true });
  });

  // sendBeacon 只能发 POST；局域网来的会被只读中间件 403，手机页面就靠超时下线
  app.post('/api/presence/bye', (c) => {
    const id = c.req.query('id') ?? '';
    if (ID_RE.test(id)) tracker.bye(id);
    return c.json({ ok: true });
  });

  const timer = setInterval(() => {
    if (tracker.shouldExit()) {
      clearInterval(timer);
      console.log('网页都关掉了，ClassRep 自动退出');
      onIdle();
    }
  }, options.checkEveryMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
