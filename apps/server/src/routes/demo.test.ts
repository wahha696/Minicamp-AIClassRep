// B6 验收：剧本列表 / 回放 / 重置 / 粘贴导入
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { MOCK_DIR } from '../paths.js';
import { buildDemoMessages, listScenarios, parseImportedText } from '../ingest/demo.js';
import { registerBusinessRoutes } from './business.js';

// 回放/导入最后会调 runPipelineNow()（C 的），这里替掉：不依赖 LLM key，也能断言"确实调了"
const { runPipelineNowMock } = vi.hoisted(() => ({ runPipelineNowMock: vi.fn(async () => {}) }));
vi.mock('../pipeline/index.js', () => ({ runPipelineNow: runPipelineNowMock }));

const SCENARIOS = ['assignment', 'cancel', 'meeting', 'noisy', 'reschedule', 'similar-exams'];

function mockScenario(name: string): {
  title: string;
  group: { id: string; name: string };
  messages: { offset_minutes: number; sender: string; text: string }[];
} {
  return JSON.parse(readFileSync(join(MOCK_DIR, `${name}.json`), 'utf8'));
}

// ===== 脚手架

function freshApp(): Hono {
  openDb(':memory:');
  const app = new Hono();
  registerBusinessRoutes(app);
  return app;
}

async function getJson(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

async function postJson(
  app: Hono,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? '{}' : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function count(table: string, where = '', params: unknown[] = []): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`;
  return (db.prepare(sql).get(...(params as never[])) as { n: number }).n;
}

beforeEach(() => {
  runPipelineNowMock.mockClear();
});

// ===== listScenarios

describe('listScenarios', () => {
  it('列出 data/mock 下全部剧本，带 title 与条数', () => {
    const list = listScenarios();
    expect(list.map((s) => s.name)).toEqual(SCENARIOS);
    for (const meta of list) {
      const raw = mockScenario(meta.name);
      expect(meta.title).toBe(raw.title);
      expect(meta.count).toBe(raw.messages.length);
      expect(meta.count).toBeGreaterThan(0);
    }
  });
});

// ===== buildDemoMessages

describe('buildDemoMessages', () => {
  it('message_id = demo-<剧本名>-<序号>，群号用剧本里的 group.id', () => {
    const msgs = buildDemoMessages('reschedule', Date.now())!;
    expect(msgs).toHaveLength(mockScenario('reschedule').messages.length);
    expect(msgs[0]!.message_id).toBe('demo-reschedule-1');
    expect(msgs[1]!.message_id).toBe('demo-reschedule-2');
    expect(msgs[0]!.group_id).toBe('demo-math');
    expect(msgs[0]!.group_name).toBe('高数(2)班');
  });

  it('sent_at = 回放时刻 + offset_minutes 分钟（相对时间不写死日期）', () => {
    const now = Date.parse('2026-09-23T12:00:00+08:00');
    const msgs = buildDemoMessages('reschedule', now)!;
    const raw = mockScenario('reschedule').messages;
    for (let i = 0; i < 5; i++) {
      expect(msgs[i]!.sent_at).toBe(now + raw[i]!.offset_minutes * 60_000);
    }
    // 相邻两条差 1 分钟 → 差 60000ms
    expect(msgs[1]!.sent_at - msgs[0]!.sent_at).toBe(60_000);
  });

  it('sender / text 原样带过来', () => {
    const now = Date.now();
    const msgs = buildDemoMessages('reschedule', now)!;
    const raw = mockScenario('reschedule').messages;
    expect(msgs[0]!.sender_name).toBe(raw[0]!.sender);
    expect(msgs[0]!.text).toBe(raw[0]!.text);
    const last = msgs[msgs.length - 1]!;
    expect(last.text).toBe(raw[raw.length - 1]!.text);
  });

  it('剧本不存在 / 名字不合法 → null（挡路径穿越）', () => {
    expect(buildDemoMessages('nope')).toBeNull();
    expect(buildDemoMessages('../package')).toBeNull();
    expect(buildDemoMessages('..\\..\\package')).toBeNull();
    expect(buildDemoMessages('a/b')).toBeNull();
  });

  it('六个剧本都能转出非空消息', () => {
    for (const name of SCENARIOS) {
      const msgs = buildDemoMessages(name, Date.now())!;
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs.every((m) => m.group_id.startsWith('demo-'))).toBe(true);
      expect(msgs.every((m) => m.text.length > 0)).toBe(true);
    }
  });
});

// ===== parseImportedText

describe('parseImportedText', () => {
  it('「昵称：内容」全角/半角冒号都认', () => {
    const msgs = parseImportedText('测试群', '张老师：明天下午两点小测\n班长: 小测改到周五\n');
    expect(msgs.map((m) => [m.sender_name, m.text])).toEqual([
      ['张老师', '明天下午两点小测'],
      ['班长', '小测改到周五'],
    ]);
  });

  it('群号 = demo-import-<群名>', () => {
    const msgs = parseImportedText('离散数学', '张老师：下周三交作业');
    expect(msgs[0]!.group_id).toBe('demo-import-离散数学');
    expect(msgs[0]!.group_name).toBe('离散数学');
  });

  it('QQ 格式：昵称 + 时间戳，下一行是内容', () => {
    const text = ['张老师 12:30:45', '@全体成员 明天下午两点在 A301 随堂小测', '小王 12:31:02', '收到'].join('\n');
    const msgs = parseImportedText('高数(2)班', text);
    expect(msgs.map((m) => [m.sender_name, m.text])).toEqual([
      ['张老师', '@全体成员 明天下午两点在 A301 随堂小测'],
      ['小王', '收到'],
    ]);
  });

  it('QQ 格式：没有秒的 12:30 也认', () => {
    const msgs = parseImportedText('群', '张老师 12:30\n明天小测');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ sender_name: '张老师', text: '明天小测' });
  });

  it('解析不了的行归到上一条', () => {
    const msgs = parseImportedText('群', '张老师：明天下午两点小测\n（以下为图片）\n小王：收到\n??');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.text).toBe('明天下午两点小测\n（以下为图片）');
    expect(msgs[1]!.text).toBe('收到\n??');
  });

  it('第一行不像消息时当作群名（groupName 为空）', () => {
    const msgs = parseImportedText('', '高数(2)班\n张老师：明天小测');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.group_id).toBe('demo-import-高数(2)班');
    expect(msgs[0]!.group_name).toBe('高数(2)班');
  });

  it('sent_at 用当前时间依次 +1 秒，message_id 是 import-<时间戳>-<序号>', () => {
    const now = 1790000000000;
    const msgs = parseImportedText('群', 'A：一\nB：二\nC：三', now);
    expect(msgs.map((m) => m.sent_at)).toEqual([now, now + 1000, now + 2000]);
    expect(msgs.map((m) => m.message_id)).toEqual([
      `import-${now}-0`,
      `import-${now}-1`,
      `import-${now}-2`,
    ]);
  });

  it('空行忽略；解析不出任何消息时返回空数组', () => {
    expect(parseImportedText('群', '')).toEqual([]);
    expect(parseImportedText('群', '\n\n   \n')).toEqual([]);
    expect(parseImportedText('群', '没有冒号的一行')).toEqual([]);
  });

  it('CRLF 换行也能解析', () => {
    const msgs = parseImportedText('群', 'A：一\r\nB：二\r\n');
    expect(msgs).toHaveLength(2);
  });

  // ===== B6 审核补充
  it('冒号格式正文里有「时间 14:30」这种行，不会被误判成 QQ 格式', () => {
    const msgs = parseImportedText('高数', '张老师：明天随堂小测\n时间 14:30\n地点 A301');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender_name).toBe('张老师');
    expect(msgs[0]!.text).toBe('明天随堂小测\n时间 14:30\n地点 A301');
  });

  it('QQ 格式带日期（张老师 2026/9/26 12:30:45）：日期不进昵称', () => {
    const msgs = parseImportedText('高数', '张老师 2026/9/26 12:30:45\n明天小测\n小王 2026-09-26 12:31\n收到');
    expect(msgs.map((m) => [m.sender_name, m.text])).toEqual([
      ['张老师', '明天小测'],
      ['小王', '收到'],
    ]);
  });

  it('群名为空且第一行就是消息：用兜底群名，group_id 不会是 demo-import-', () => {
    const msgs = parseImportedText('', '张老师：明天小测');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.group_name).toBe('粘贴导入');
    expect(msgs[0]!.group_id).toBe('demo-import-粘贴导入');
  });
});

// ===== HTTP 路由

describe('GET /api/demo/scenarios', () => {
  it('返回剧本列表', async () => {
    const app = freshApp();
    const { status, body } = await getJson(app, '/api/demo/scenarios');
    expect(status).toBe(200);
    const list = body as { name: string; title: string; count: number }[];
    expect(list.map((s) => s.name)).toEqual(SCENARIOS);
    expect(list[0]).toHaveProperty('title');
    expect(list[0]).toHaveProperty('count');
  });
});

describe('POST /api/demo/replay', () => {
  it('注入消息 + 登记群 + 调 runPipelineNow', async () => {
    const app = freshApp();
    const raw = mockScenario('reschedule');

    const { status, body } = await postJson(app, '/api/demo/replay', { scenario: 'reschedule' });
    expect(status).toBe(200);
    expect(body).toEqual({ injected: raw.messages.length });
    expect(runPipelineNowMock).toHaveBeenCalledTimes(1);

    expect(count('messages', 'group_id = ?', ['demo-math'])).toBe(raw.messages.length);
    expect(count('groups', 'group_id = ?', ['demo-math'])).toBe(1);
    const row = db
      .prepare('SELECT name, enabled, adapter FROM groups WHERE group_id = ?')
      .get('demo-math') as { name: string; enabled: number; adapter: string };
    expect(row).toMatchObject({ name: '高数(2)班', enabled: 1, adapter: 'demo' });
  });

  it('回放两次不产生重复消息（幂等）', async () => {
    const app = freshApp();
    const raw = mockScenario('meeting');
    await postJson(app, '/api/demo/replay', { scenario: 'meeting' });
    const second = await postJson(app, '/api/demo/replay', { scenario: 'meeting' });
    expect(second.body).toEqual({ injected: 0 });
    expect(count('messages', 'group_id = ?', ['demo-committee'])).toBe(raw.messages.length);
  });

  it('不同剧本进不同的群', async () => {
    const app = freshApp();
    await postJson(app, '/api/demo/replay', { scenario: 'reschedule' });
    await postJson(app, '/api/demo/replay', { scenario: 'assignment' });
    expect(count('groups')).toBe(2);
    expect(count('messages', 'group_id = ?', ['demo-physics-lab'])).toBe(
      mockScenario('assignment').messages.length,
    );
  });

  it('剧本不存在 → 404；body 不合法 → 400；非 JSON → 400', async () => {
    const app = freshApp();
    expect((await postJson(app, '/api/demo/replay', { scenario: 'nope' })).status).toBe(404);
    expect((await postJson(app, '/api/demo/replay', { scenario: '' })).status).toBe(400);
    expect((await postJson(app, '/api/demo/replay', {})).status).toBe(400);
    const bad = await app.request('/api/demo/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{不是 JSON',
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/demo/reset', () => {
  it('删掉所有 demo- 开头的群及其数据，保留真实群', async () => {
    const app = freshApp();
    // 一个真实群（非 demo-）+ 两个演示群
    db.prepare(
      'INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
    ).run('123456', '真实课程群', 'onebot', Date.now());
    db.prepare(
      'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)',
    ).run('real-1', '123456', '张老师', '真实消息', Date.now(), 'onebot', Date.now());

    await postJson(app, '/api/demo/replay', { scenario: 'reschedule' });
    await postJson(app, '/api/demo/replay', { scenario: 'assignment' });
    // 给演示群塞一条事件 + 来源 + 变更
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO events (group_id, type, title, description, start_at, status, confidence, version, created_at, updated_at)
           VALUES ('demo-math', 'exam', '高数小测', '', ?, 'active', 0.9, 1, ?, ?)`,
        )
        .run(Date.now(), Date.now(), Date.now()).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)',
    ).run(eventId, 'demo-reschedule-1', '小王', '早', Date.now());
    db.prepare(
      'INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at) VALUES (?, 1, ?, ?, ?)',
    ).run(eventId, '{"location":{"from":null,"to":"A301"}}', 'demo-reschedule-1', Date.now());

    const { status, body } = await postJson(app, '/api/demo/reset');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    expect(count('groups', "group_id LIKE 'demo-%'")).toBe(0);
    expect(count('messages', "group_id LIKE 'demo-%'")).toBe(0);
    expect(count('events', "group_id LIKE 'demo-%'")).toBe(0);
    expect(count('event_sources', 'event_id = ?', [eventId])).toBe(0);
    expect(count('event_history', 'event_id = ?', [eventId])).toBe(0);

    // 真实群与它的消息不受影响
    expect(count('groups', 'group_id = ?', ['123456'])).toBe(1);
    expect(count('messages', 'group_id = ?', ['123456'])).toBe(1);
  });

  it('reset 之后可以重新回放', async () => {
    const app = freshApp();
    await postJson(app, '/api/demo/replay', { scenario: 'cancel' });
    await postJson(app, '/api/demo/reset');
    const again = await postJson(app, '/api/demo/replay', { scenario: 'cancel' });
    expect((again.body as { injected: number }).injected).toBe(
      mockScenario('cancel').messages.length,
    );
  });

  it('没有演示数据时也返回 ok', async () => {
    const app = freshApp();
    expect(await postJson(app, '/api/demo/reset')).toMatchObject({ status: 200, body: { ok: true } });
  });
});

describe('POST /api/import/text', () => {
  it('解析并入库 + 调 runPipelineNow，返回条数', async () => {
    const app = freshApp();
    const { status, body } = await postJson(app, '/api/import/text', {
      groupName: '离散数学',
      text: '张老师：下周三交作业\n小王：收到',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ messages: 2 });
    expect(runPipelineNowMock).toHaveBeenCalledTimes(1);

    const rows = db
      .prepare('SELECT message_id, group_id, source FROM messages ORDER BY sent_at')
      .all() as unknown as { message_id: string; group_id: string; source: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.group_id).toBe('demo-import-离散数学');
    expect(rows[0]!.source).toBe('import');
    expect(rows[0]!.message_id).toMatch(/^import-\d+-0$/);
  });

  it('QQ 复制格式也能入库', async () => {
    const app = freshApp();
    const { body } = await postJson(app, '/api/import/text', {
      groupName: '高数(2)班',
      text: '张老师 12:30:45\n@全体成员 明天下午两点小测\n',
    });
    expect(body).toEqual({ messages: 1 });
    const row = db.prepare('SELECT text FROM messages').get() as { text: string };
    expect(row.text).toBe('@全体成员 明天下午两点小测');
  });

  it('群名省略时用第一行', async () => {
    const app = freshApp();
    await postJson(app, '/api/import/text', { text: '离散数学\n张老师：下周三交作业' });
    expect(count('groups', 'group_id = ?', ['demo-import-离散数学'])).toBe(1);
  });

  it('text 为空 / 解析不出消息 → 400；body 不合法 → 400', async () => {
    const app = freshApp();
    expect((await postJson(app, '/api/import/text', { groupName: '群', text: '' })).status).toBe(400);
    expect((await postJson(app, '/api/import/text', { groupName: '群', text: '没有冒号' })).status).toBe(
      400,
    );
    expect((await postJson(app, '/api/import/text', { groupName: '群' })).status).toBe(400);
    expect((await postJson(app, '/api/import/text', {})).status).toBe(400);
  });

  it('导入的群也能被 reset 清掉（demo- 前缀）', async () => {
    const app = freshApp();
    await postJson(app, '/api/import/text', { groupName: '临时群', text: 'A：一' });
    await postJson(app, '/api/demo/reset');
    expect(count('groups')).toBe(0);
    expect(count('messages')).toBe(0);
  });
});
