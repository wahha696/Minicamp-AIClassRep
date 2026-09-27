// /api/connect/* 与 /api/sync。主人是 A。接口格式见 00-总约定 §7。
import { readFile } from 'node:fs/promises';
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { syncHistory } from '../ingest/history.js';
import { QRCODE_PATH } from '../napcat/paths.js';
import { isOnline } from '../napcat/onebot.js';
import { logoutNapcat, restartNapcat } from '../napcat/index.js';
import { getConnectStatus } from '../napcat/state.js';

export function registerConnectRoutes(app: Hono): void {
  // GET /api/connect/status → ConnectStatusDTO（前端每 2s 轮询）
  app.get('/api/connect/status', (c) => c.json(getConnectStatus()));

  // GET /api/connect/qrcode → napcat/cache/qrcode.png（不存在则 404）；no-store：每 2s 重取新码
  app.get('/api/connect/qrcode', async (c) => {
    let png: Buffer;
    try {
      png = await readFile(QRCODE_PATH);
    } catch {
      return c.json({ error: '还没有二维码' }, 404);
    }
    return c.body(new Uint8Array(png), 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    });
  });

  // POST /api/connect/restart：结束本进程树 + 结束所有 QQ.exe → 重新 spawn → 复位 WS 的 kicked 状态
  // （「关闭电脑版 QQ 并继续」「重新连接」「重启采集端」共用，架构.md §5）
  // body 可选 { kill_qq: true }：只有「关闭电脑版 QQ 并继续」按钮传，才会结束用户自己的 QQ（修复计划 S4）
  app.post('/api/connect/restart', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kill_qq?: unknown } | null;
    try {
      await restartNapcat({ killUserQQ: body?.kill_qq === true });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `重启采集端失败：${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/connect/logout：退出当前 QQ（忘掉 QQ 号 + 重启采集端）→ 回到扫码，可换号登录。
  // 数据按号分库存着，换回来原样恢复；body 可选 { erase: true } = 「退出并删除本号数据」（不可恢复）
  app.post('/api/connect/logout', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { erase?: unknown } | null;
    try {
      await logoutNapcat({ erase: body?.erase === true });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `退出登录失败：${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/sync：未连接时 409；online 时往前补拉群历史（FR-16）。
  // body 可选 {days: 1|7|30}，缺省/空 body 都按 7 天（登录后自动补齐就是走这个）。入库完即返回。
  app.post('/api/sync', async (c) => {
    if (!isOnline()) return c.json({ error: 'QQ 未连接' }, 409);

    let days: 1 | 7 | 30 = 7;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined; // 空 body 也算合法（保持旧行为）
    }
    if (raw !== undefined) {
      const parsed = syncSchema.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'days 只能是 1 / 7 / 30' }, 400);
      days = parsed.data.days;
    }

    try {
      return c.json(await syncHistory(days));
    } catch (err) {
      return c.json({ error: `同步失败：${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/sync/status：每群最近一次历史补齐的结果（R03，只读，离线也能看上次补到哪）
  // complete=0 的群 = 可能被截断/中途失败，前端可提示「这群没补全，建议再同步一次」
  app.get('/api/sync/status', (c) => {
    try {
      const rows = db
        .prepare(
          `SELECT s.group_id, COALESCE(g.name, s.group_id) AS name,
                  s.last_sync_at, s.oldest_at, s.complete, s.reason
           FROM group_sync s LEFT JOIN groups g ON g.group_id = s.group_id
           ORDER BY s.last_sync_at DESC`,
        )
        .all();
      return c.json(rows);
    } catch {
      return c.json([]); // 表还没建（旧库首启）→ 空数组，不 500
    }
  });
}

const syncSchema = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
});
