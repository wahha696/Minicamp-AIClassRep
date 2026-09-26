// B7 验收：局域网只读中间件
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isLocalAddress, lanReadOnly, remoteAddressOf } from './lan-guard.js';

/** 造一个只挂了中间件的 app；env 通过 app.request 的第三个参数注入（模拟 c.env） */
function makeApp(): Hono {
  const app = new Hono();
  app.use('*', lanReadOnly());
  app.get('/api/ping', (c) => c.json({ ok: true }));
  app.on('HEAD', '/api/ping', (c) => c.body(null, 200));
  app.post('/api/things', (c) => c.json({ ok: true }));
  app.patch('/api/things/:id', (c) => c.json({ ok: true }));
  app.delete('/api/things/:id', (c) => c.json({ ok: true }));
  return app;
}

function envOf(remoteAddress: string | undefined): unknown {
  return remoteAddress === undefined
    ? { incoming: { socket: {} } }
    : { incoming: { socket: { remoteAddress } } };
}

async function call(
  method: string,
  path: string,
  remoteAddress: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const app = makeApp();
  const res = await app.request(path, { method }, envOf(remoteAddress));
  return { status: res.status, body: res.status === 403 ? await res.json() : null };
}

describe('remoteAddressOf', () => {
  it('取不到来源地址时返回空串（无 env / 无 socket / 无字段）', async () => {
    const app = new Hono();
    let seen: string | null = null;
    app.use('*', async (c, next) => {
      seen = remoteAddressOf(c);
      await next();
    });
    app.get('/', (c) => c.text('ok'));

    const cases: unknown[] = [
      undefined,
      {},
      { incoming: {} },
      { incoming: { socket: {} } },
      { incoming: { socket: { remoteAddress: '' } } },
    ];
    for (const env of cases) {
      seen = null;
      await app.request('/', {}, env as never);
      expect(seen).toBe('');
    }
  });

  it('去掉 IPv4-mapped 前缀 ::ffff:', async () => {
    const app = new Hono();
    let seen = '';
    app.use('*', async (c, next) => {
      seen = remoteAddressOf(c);
      await next();
    });
    app.get('/', (c) => c.text('ok'));

    await app.request('/', {}, envOf('::ffff:192.168.1.5') as never);
    expect(seen).toBe('192.168.1.5');
    await app.request('/', {}, envOf('::ffff:127.0.0.1') as never);
    expect(seen).toBe('127.0.0.1');
    await app.request('/', {}, envOf('::1') as never);
    expect(seen).toBe('::1');
  });
});

describe('isLocalAddress', () => {
  it('只有三个 loopback 值算本机，空串不算', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('')).toBe(false);
    expect(isLocalAddress('192.168.1.5')).toBe(false);
    expect(isLocalAddress('10.0.0.7')).toBe(false);
    expect(isLocalAddress('0.0.0.0')).toBe(false);
  });
});

describe('lanReadOnly 中间件', () => {
  it('本机（127.0.0.1）写操作放行', async () => {
    expect((await call('POST', '/api/things', '127.0.0.1')).status).toBe(200);
    expect((await call('PATCH', '/api/things/1', '127.0.0.1')).status).toBe(200);
    expect((await call('DELETE', '/api/things/1', '127.0.0.1')).status).toBe(200);
  });

  it('IPv6 loopback（::1）与 IPv4-mapped（::ffff:127.0.0.1）也算本机', async () => {
    expect((await call('POST', '/api/things', '::1')).status).toBe(200);
    expect((await call('POST', '/api/things', '::ffff:127.0.0.1')).status).toBe(200);
  });

  it('局域网地址写操作 → 403 局域网访问只读', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      const res = await call(method, '/api/things/1', '192.168.1.5');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: '局域网访问只读' });
    }
  });

  it('局域网地址读操作放行（GET / HEAD）', async () => {
    expect((await call('GET', '/api/ping', '192.168.1.5')).status).toBe(200);
    expect((await call('HEAD', '/api/ping', '192.168.1.5')).status).toBe(200);
  });

  it('来源地址取不到（空串）时按非本机处理：写操作 403', async () => {
    const res = await call('POST', '/api/things', '');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: '局域网访问只读' });
  });

  it('完全没有 c.env（没有 incoming/socket）时写操作也 403', async () => {
    for (const env of [undefined, {}, { incoming: {} }, { incoming: { socket: {} } }]) {
      const app = makeApp();
      const res = await app.request('/api/things', { method: 'POST' }, env as never);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: '局域网访问只读' });
    }
  });

  it('地址取不到时读操作仍然放行', async () => {
    const app = makeApp();
    const res = await app.request('/api/ping', {}, undefined as never);
    expect(res.status).toBe(200);
  });

  it('放行的请求会继续走到后面的处理器（响应体来自业务路由）', async () => {
    const app = makeApp();
    const res = await app.request('/api/ping', {}, envOf('127.0.0.1') as never);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('403 响应不调用后续处理器', async () => {
    const app = new Hono();
    let reached = false;
    app.use('*', lanReadOnly());
    app.post('/api/things', (c) => {
      reached = true;
      return c.json({ ok: true });
    });
    const res = await app.request('/api/things', { method: 'POST' }, envOf('192.168.1.5') as never);
    expect(res.status).toBe(403);
    expect(reached).toBe(false);
  });
});
