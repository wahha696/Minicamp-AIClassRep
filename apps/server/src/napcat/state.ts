// 连接状态机（架构.md §4）。主人是 A（分工 A5）。
// 判定严格按架构.md §4 表格自上而下、先命中者为准：
//   qq_conflict → error → kicked → online → waiting_qr → reconnecting → starting
// error 的 message 用架构.md §7 原文案；非 Windows 按 00-总约定 §6 返回。
import { existsSync } from 'node:fs';
import { db } from '../db/index.js';
import type { ConnectState, ConnectStatusDTO } from '../types.js';
import { getManagerFacts, getUin, type ManagerFacts } from './manager.js';
import { getOnebotFacts } from './onebot.js';
import { QRCODE_PATH } from './paths.js';

// ===== 架构.md §7 的用户文案 =====
export const MSG_QQ_CONFLICT = 'ClassRep 需要接管电脑版 QQ，期间请用手机 QQ 聊天';
export const MSG_NO_QQ = '需要先安装 QQ 电脑版';
export const MSG_CRASH = '采集端异常。常见原因是 QQ 版本过旧，请更新到最新版 QQ 后重试';
export const MSG_UNSUPPORTED = '当前系统不支持采集端（开发模式，可用演示回放）';

let since = Date.now();
let lastState: ConnectState | null = null;

/** state.ts 判定所需的全部输入（抽出便于测试） */
export interface ConnectInputs {
  manager: ManagerFacts;
  onebot: { wsConnected: boolean; everOnline: boolean; selfId: string | null; kicked: boolean };
  qrcodeExists: boolean;
  uin: string | undefined;
  /** messages 与 events 表都为空 */
  dbEmpty: boolean;
  isWindows: boolean;
}

/**
 * 状态判定（纯函数，不碰真实环境）。严格按架构.md §4 表格自上而下：
 * qq_conflict → error → kicked → online → waiting_qr → reconnecting → starting
 */
export function deriveConnectStatus(input: ConnectInputs): { state: ConnectState; message?: string; first_run: boolean; uin?: string } {
  const { manager: m, onebot: o, qrcodeExists, uin, dbEmpty, isWindows } = input;
  const firstRun = uin === undefined && dbEmpty;

  if (!isWindows) {
    // 00-总约定 §6：非 Windows 返回
    return { state: 'error', message: MSG_UNSUPPORTED, first_run: firstRun };
  }

  if (m.conflictAtBoot && m.pid === null) {
    // 启动时检测到 QQ.exe 在运行，尚未 spawn → 等用户点「关闭电脑版 QQ 并继续」
    return { state: 'qq_conflict', message: MSG_QQ_CONFLICT, first_run: firstRun };
  }
  if (m.qqExe === null) {
    return { state: 'error', message: MSG_NO_QQ, first_run: firstRun, uin }; // 没装 QQ
  }
  if (m.crashLoop || m.spawnFailed) {
    // spawn 失败 / 进程 60s 内退出 ≥3 次（架构.md §7 反复崩溃文案）
    return { state: 'error', message: MSG_CRASH, first_run: firstRun, uin };
  }
  if (o.kicked) {
    // 收到 bot_offline 且进程树已被结束；等用户点「重新连接」，不自动重启
    return { state: 'kicked', first_run: firstRun, uin };
  }
  if (o.wsConnected && o.selfId !== null) {
    return { state: 'online', first_run: firstRun, uin };
  }
  if (m.pid !== null && !o.wsConnected && qrcodeExists) {
    return { state: 'waiting_qr', first_run: firstRun, uin }; // 本次 spawn 后二维码已出现，WS 未连上
  }
  if (o.everOnline && !o.wsConnected && m.pid !== null) {
    return { state: 'reconnecting', first_run: firstRun, uin };
  }
  return { state: 'starting', first_run: firstRun, uin };
}

/** B 的 index.ts 与 /health 调用：收集真实输入后走纯判定，并维护「进入当前状态的时间」 */
export function getConnectStatus(): ConnectStatusDTO {
  const derived = deriveConnectStatus({
    manager: getManagerFacts(),
    onebot: getOnebotFacts(),
    qrcodeExists: existsSync(QRCODE_PATH),
    uin: getUin(),
    dbEmpty: tablesEmpty(),
    isWindows: process.platform === 'win32',
  });
  if (derived.state !== lastState) {
    lastState = derived.state;
    since = Date.now();
  }
  const dto: ConnectStatusDTO = {
    state: derived.state,
    since,
    first_run: derived.first_run,
  };
  if (derived.uin !== undefined) dto.uin = derived.uin;
  if (derived.message !== undefined) dto.message = derived.message;
  return dto;
}

/** messages 与 events 表都为空 → first_run（00-总约定 §4 ConnectStatusDTO.first_run） */
function tablesEmpty(): boolean {
  try {
    const a = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number | bigint } | undefined;
    const b = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number | bigint } | undefined;
    return Number(a?.c ?? 0) === 0 && Number(b?.c ?? 0) === 0;
  } catch {
    return true; // 表还没建（openDb 之前）按空处理
  }
}
