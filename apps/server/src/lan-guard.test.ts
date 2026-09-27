// B7 验收：局域网只读中间件
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { accessGuard, hostnameOf, isLocalAddress, lanReadOnly, remoteAddressOf } from './lan-guard.js';

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


// ===== 修复计划 S1/S2：accessGuard =====

function guardApp(token: string | null): Hono {
  const app = new Hono();
  app.use('*', accessGuard({ lanToken: () => token, lanHosts: () => ['192.168.1.10'] }));
  app.get('/api/today', (c) => c.json({ ok: true }));
  app.get('/api/connect/qrcode', (c) => c.json({ ok: true }));
  app.post('/api/things', (c) => c.json({ ok: true }));
  return app;
}

async function req(
  app: Hono,
  method: string,
  path: string,
  remote: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, { method, headers }, envOf(remote) as never);
}

describe('hostnameOf', () => {
  it('去端口、小写、IPv6 保留方括号', () => {
    expect(hostnameOf('LocalHost:8000')).toBe('localhost');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:8001')).toBe('[::1]');
    expect(hostnameOf('evil.com:8000')).toBe('evil.com');
  });
});

describe('accessGuard：Host 校验（防 DNS rebinding）', () => {
  it('本机来源但 Host 是外部域名 → 421', async () => {
    const res = await req(guardApp(null), 'GET', '/api/today', '127.0.0.1', { host: 'evil.com:8000' });
    expect(res.status).toBe(421);
  });

  it('localhost / 127.0.0.1 / [::1] / 本机网卡 IP 都放行', async () => {
    for (const host of ['localhost:8000', '127.0.0.1:8003', '[::1]:8000', '192.168.1.10:8000']) {
      const res = await req(guardApp(null), 'GET', '/api/today', '127.0.0.1', { host });
      expect(res.status, host).toBe(200);
    }
  });
});

describe('accessGuard：本机写操作的 Origin 校验（防 CSRF）', () => {
  const JSON_CT = { 'content-type': 'application/json' };

  it('同源 Origin 放行', async () => {
    const res = await req(guardApp(null), 'POST', '/api/things', '127.0.0.1', {
      host: 'localhost:8000',
      origin: 'http://localhost:8000',
      ...JSON_CT,
    });
    expect(res.status).toBe(200);
  });

  it('开发时 Vite 5173 端口的 Origin 也放行（端口不限）', async () => {
    const res = await req(guardApp(null), 'POST', '/api/things', '127.0.0.1', {
      host: 'localhost:8000',
      origin: 'http://localhost:5173',
      ...JSON_CT,
    });
    expect(res.status).toBe(200);
  });

  it('跨站 Origin → 403', async () => {
    const res = await req(guardApp(null), 'POST', '/api/things', '127.0.0.1', {
      host: 'localhost:8000',
      origin: 'https://evil.example',
      ...JSON_CT,
    });
    expect(res.status).toBe(403);
  });

  it('Origin: null（沙箱 iframe / file://）→ 403', async () => {
    const res = await req(guardApp(null), 'POST', '/api/things', '127.0.0.1', {
      host: 'localhost:8000',
      origin: 'null',
      ...JSON_CT,
    });
    expect(res.status).toBe(403);
  });

  it('没有 Origin（curl、非浏览器）+ JSON → 放行', async () => {
    const res = await req(guardApp(null), 'POST', '/api/things', '127.0.0.1', {
      host: 'localhost:8000',
      ...JSON_CT,
    });
    expect(res.status).toBe(200);
  });

  it('S2：写请求不带 JSON Content-Type → 415（表单 CSRF 走不通）', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', '']) {
      const headers: Record<string, string> = { host: 'localhost:8000' };
      if (ct !== '') headers['content-type'] = ct;
      const res = await req(guardApp(null), 'POST', '/api/things', '127.0.0.1', headers);
      expect(res.status, ct || '(无 content-type)').toBe(415);
    }
  });

  it('本机 GET 不校验 Origin', async () => {
    const res = await req(guardApp(null), 'GET', '/api/today', '127.0.0.1', {
      host: 'localhost:8000',
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(200);
  });
});

describe('accessGuard：局域网访问', () => {
  const lanHost = { host: '192.168.1.10:8000' };

  it('开关关闭 → 403', async () => {
    const res = await req(guardApp(null), 'GET', '/api/today', '192.168.1.20', lanHost);
    expect(res.status).toBe(403);
  });

  it('开关打开但没带 token → 401', async () => {
    const res = await req(guardApp('secret-token-123456'), 'GET', '/api/today', '192.168.1.20', lanHost);
    expect(res.status).toBe(401);
  });

  it('?token= 正确 → 200 并写 cookie', async () => {
    const res = await req(guardApp('secret-token-123456'), 'GET', '/api/today?token=secret-token-123456', '192.168.1.20', lanHost);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('classrep_lan=secret-token-123456');
  });

  it('cookie 正确 → 200', async () => {
    const res = await req(guardApp('secret-token-123456'), 'GET', '/api/today', '192.168.1.20', {
      ...lanHost,
      cookie: 'classrep_lan=secret-token-123456',
    });
    expect(res.status).toBe(200);
  });

  it('token 错误 → 401', async () => {
    const res = await req(guardApp('secret-token-123456'), 'GET', '/api/today?token=wrong', '192.168.1.20', lanHost);
    expect(res.status).toBe(401);
  });

  it('带 token 的写操作仍然 403（只读）', async () => {
    const res = await req(guardApp('secret-token-123456'), 'POST', '/api/things', '192.168.1.20', {
      ...lanHost,
      cookie: 'classrep_lan=secret-token-123456',
    });
    expect(res.status).toBe(403);
  });

  it('带 token 也读不到二维码（敏感接口只允许本机）', async () => {
    const res = await req(guardApp('secret-token-123456'), 'GET', '/api/connect/qrcode', '192.168.1.20', {
      ...lanHost,
      cookie: 'classrep_lan=secret-token-123456',
    });
    expect(res.status).toBe(403);
  });
});
