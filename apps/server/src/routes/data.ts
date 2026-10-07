import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import {
  accountBackupStatus,
  accountControlContextMatches,
  accountControlUin,
  accountDbPath,
  currentAccount,
  restoreCurrentAccountBackup,
} from '../accounts.js';
import { createPortableBackup, MAX_BACKUP_BYTES, writeParsedBackup } from '../data-backup.js';
import { createDiagnosticReport } from '../diagnostics.js';

function downloadName(now = new Date()): string {
  return `ClassRep-backup-${now.toISOString().replace(/[-:]/g, '').slice(0, 13)}.classrep-backup`;
}

export function registerDataRoutes(app: Hono): void {
  app.get('/api/settings/diagnostics', (c) => {
    const report = `${JSON.stringify(createDiagnosticReport(), null, 2)}\n`;
    return c.body(report, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ClassRep-diagnostic.json"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.get('/api/settings/data', (c) => {
    if (currentAccount() === null) return c.json({ error: '请先登录 QQ 再备份账号数据' }, 409);
    return c.json(accountBackupStatus());
  });

  app.get('/api/settings/data/backup', (c) => {
    if (currentAccount() === null) return c.json({ error: '请先登录 QQ 再备份账号数据' }, 409);
    try {
      const backup = createPortableBackup();
      return c.body(new Uint8Array(backup), 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${downloadName()}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (error) {
      return c.json({ error: `生成备份失败：${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  });

  // 该接口会主动进入账号 transition，不能持有 accountMutationGuard 的共享 lease。
  // 所以它自行冻结并核对 epoch；accessGuard 仍会限制本机、Origin 与专用 Content-Type。
  app.post('/api/settings/data/restore', async (c) => {
    const epoch = c.req.header('X-ClassRep-Account-Epoch')?.trim() ?? '';
    // 数据库损坏/挂载失败时 currentAccount 可能为 null 或旧账号，
    // 恢复必须针对 fail-closed 控制面记住的真正目标账号。
    const uin = accountControlUin();
    if (uin === null || !accountControlContextMatches(epoch, uin)) {
      return c.json({ error: '账号已切换或正在切换，请刷新后重试' }, 409);
    }
    const declared = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) {
      return c.json({ error: '备份文件超过 256 MB' }, 413);
    }
    let input: Uint8Array;
    try {
      input = new Uint8Array(await c.req.arrayBuffer());
    } catch {
      return c.json({ error: '无法读取备份文件' }, 400);
    }
    if (input.byteLength > MAX_BACKUP_BYTES) return c.json({ error: '备份文件超过 256 MB' }, 413);

    const candidate = join(dirname(accountDbPath(uin)), `.restore-upload-${randomUUID()}.db`);
    try {
      writeParsedBackup(input, candidate);
      const result = await restoreCurrentAccountBackup(epoch, candidate);
      if (result.status === 'stale') return c.json({ error: '账号已切换，请重新选择备份文件' }, 409);
      return c.json({ ok: true, safety_backup_created: true });
    } catch (error) {
      return c.json({ error: `恢复备份失败：${error instanceof Error ? error.message : String(error)}` }, 400);
    } finally {
      rmSync(candidate, { force: true });
    }
  });
}
