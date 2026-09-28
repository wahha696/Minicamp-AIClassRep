// /api/setup/*（四问题修复 #3）：采集端组件一键下载；/api/accounts/*（问题 1 延伸）账号数据管理。
// 下载本体在 scripts/fetch-napcat.mjs（bootstrap 与 API 共用），这里只负责拉起子进程 + 汇报进度。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { deleteInactiveAccountData, legacyDataExists, listAccounts } from '../accounts.js';
import { DATA_DIR, NAPCAT_DIR, ROOT } from '../paths.js';

const NAPCAT_BOOT_EXE = 'NapCatWinBootMain.exe';
const FETCH_SCRIPT = join(ROOT, 'scripts', 'fetch-napcat.mjs');
const PROGRESS_FILE = join(DATA_DIR, 'logs', 'fetch-napcat-progress.json');

export type SetupStatus = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error';

export interface SetupProgressDTO {
  status: SetupStatus;
  percent: number; // 下载中 0~99，完成 100，未开始/不可用 -1
  message: string;
  installed: boolean; // napcat/NapCatWinBootMain.exe 是否已就绪
}

let child: ReturnType<typeof spawn> | null = null;

export function registerSetupRoutes(app: Hono): void {
  // GET /api/setup/napcat → 组件是否就绪 + 最近一次下载进度（前端连接页轮询）
  app.get('/api/setup/napcat', (c) => c.json(setupProgressDTO()));

  // POST /api/setup/fetch-napcat → 后台下载 NapCat 运行包（立即返回，进度走上面的接口）
  app.post('/api/setup/fetch-napcat', (c) => {
    if (isNapcatInstalled()) return c.json({ ok: true, status: 'done' });
    if (!existsSync(FETCH_SCRIPT)) {
      // 免安装包不带 scripts/（组件已打进 napcat/）；缺组件只能重下完整包
      return c.json({ error: '当前是免安装版，采集端组件应已内置；如缺失请重新下载完整安装包' }, 501);
    }
    if (child !== null && child.exitCode === null) {
      return c.json({ error: '下载已在进行中，请看进度条' }, 409);
    }
    try {
      mkdirSync(join(DATA_DIR, 'logs'), { recursive: true });
      child = spawn(process.execPath, [FETCH_SCRIPT, '--progress-file', PROGRESS_FILE], {
        cwd: ROOT,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('exit', (code) => {
        if (code !== null && code !== 0) {
          // 脚本正常会自己把 error 写进进度文件；这里兜底防子进程裸崩没写
          const last = readProgressJson();
          if (last === null || last.status === 'downloading' || last.status === 'verifying' || last.status === 'extracting') {
            writeProgress('error', -1, '下载失败，请检查网络后重试');
          }
        }
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `启动下载失败：${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/accounts → 本机账号库列表（问题 1 延伸：网页可查看/删除账号数据）
  app.get('/api/accounts', (c) => c.json({ accounts: listAccounts(), legacy_data: legacyDataExists() }));

  // DELETE /api/accounts/:uin → 只删非活动账号。当前号必须走「退出并删除本号数据」，
  // 否则单独切到兜底库会让 NapCat 仍在线、业务库却已无账号，形成假在线。
  app.delete('/api/accounts/:uin', async (c) => {
    const uin = c.req.param('uin');
    try {
      const result = await deleteInactiveAccountData(uin);
      if (result === 'active') {
        return c.json({ error: '当前 NapCat 登录账号不能直接删除，请使用“退出并删除本号数据”' }, 409);
      }
      if (result === 'not_found') return c.json({ error: '该账号在本机没有数据' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `删除失败：${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });
}

/** /api/setup/napcat 的返回体（也供 state.ts 之外需要「组件是否就绪」的地方用） */
export function isNapcatInstalled(): boolean {
  return existsSync(join(NAPCAT_DIR, NAPCAT_BOOT_EXE));
}

function readProgressJson(): { status?: string; percent?: number; message?: string } | null {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) as { status?: string; percent?: number; message?: string };
  } catch {
    return null;
  }
}

export function setupProgressDTO(): SetupProgressDTO {
  let raw: { status?: string; percent?: number; message?: string } | null = null;
  try {
    raw = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) as { status?: string; percent?: number; message?: string };
  } catch {
    // 没有进度文件 = 没下载过
  }
  const status = raw?.status;
  const known =
    status === 'downloading' || status === 'verifying' || status === 'extracting' || status === 'done' || status === 'error';
  return {
    status: known ? (status as SetupStatus) : 'idle',
    percent: typeof raw?.percent === 'number' ? raw.percent : -1,
    message: typeof raw?.message === 'string' ? raw.message : '',
    installed: isNapcatInstalled(),
  };
}

/** 子进程裸崩时的兜底写入（fetch-napcat.mjs 正常会自己写进度） */
function writeProgress(status: SetupStatus, percent: number, message: string): void {
  try {
    mkdirSync(dirname(PROGRESS_FILE), { recursive: true });
    writeFileSync(PROGRESS_FILE, `${JSON.stringify({ status, percent, message, at: Date.now() })}\n`, 'utf8');
  } catch { /* 进度写不进不影响主流程 */ }
}
