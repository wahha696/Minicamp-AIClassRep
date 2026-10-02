// 连接状态机（架构.md §4）。主人是 A（分工 A5）。
// 判定严格按架构.md §4 表格自上而下、先命中者为准：
//   qq_conflict → error → kicked → online → waiting_qr → reconnecting → starting
// error 的 message 用架构.md §7 原文案；非 Windows 按 00-总约定 §6 返回。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { accountDataState, accountEpoch, legacyDataExists } from '../accounts.js';
import { getLlmConfig } from '../ai-settings.js';
import type { ConnectState, ConnectStatusDTO } from '../types.js';
import { getManagerFacts, getUin, type ManagerFacts } from './manager.js';
import { EXTERNAL_ONEBOT, getOnebotFacts, getSelfNickname } from './onebot.js';
import { NAPCAT_DIR, QRCODE_PATH } from './paths.js';
import { getDesktopStatus } from './desktop-recovery.js';

/** 采集端主程序：缺它 = 缺运行包（git 克隆不带 napcat/，发布包自带；缺了给一键下载入口） */
const NAPCAT_BOOT_EXE = join(NAPCAT_DIR, 'NapCatWinBootMain.exe');

// ===== 架构.md §7 的用户文案 =====
export const MSG_QQ_CONFLICT = 'ClassRep 需要接管电脑版 QQ，期间请用手机 QQ 聊天';
export const MSG_NO_QQ = '需要先安装 QQ 电脑版';
export const MSG_NO_NAPCAT = '采集端组件缺失。点「一键下载 NapCat 组件」自动补齐，也可以把 NapCat 运行包手动放进 napcat/ 目录';
export const MSG_CRASH = '采集端异常。常见原因是 QQ 版本过旧，请更新到最新版 QQ 后重试';
export const MSG_UNSUPPORTED = '当前系统不支持采集端（开发模式，可用演示回放）';
export const MSG_NAPCAT_MISSING = '采集组件缺失（napcat 文件夹不完整），请重新克隆仓库或下载完整发布包';
export const MSG_ACCOUNT_DB = '账号数据初始化失败（磁盘空间或权限问题）。消息暂不写入避免写错账号，请点「重新连接」或重启应用重试';

let since = Date.now();
let lastState: ConnectState | null = null;

/** state.ts 判定所需的全部输入（抽出便于测试） */
export interface ConnectInputs {
  manager: ManagerFacts;
  onebot: { wsConnected: boolean; everOnline: boolean; selfId: string | null; kicked: boolean; accountError?: string | null };
  qrcodeExists: boolean;
  uin: string | undefined;
  /** DeepSeek Key 是否已配置（网页或 .env） */
  deepseekConfigured: boolean;
  isWindows: boolean;
  /** napcat/NapCatWinBootMain.exe 是否存在（缺 = 缺运行包，克隆后未下载的典型状态）；缺省 true */
  napcatInstalled?: boolean;
  /** Docker 等外部 OneBot 部署（ONEBOT_WS_URL 指向远端）：不检查本机 QQ/NapCat，只看 WS 通不通 */
  externalOnebot?: boolean;
}

/**
 * 状态判定（纯函数，不碰真实环境）。严格按架构.md §4 表格自上而下：
 * qq_conflict → error → kicked → online → waiting_qr → reconnecting → starting
 *
 * first_run（修复计划第一节 §5）：「没有 uin 或 DeepSeek 未配置」→ 前端拦到 /setup 向导；
 * 不看库里有没有数据（账号化之后库按号分，「库为空」不再是首次使用的信号）。
 */
export function deriveConnectStatus(input: ConnectInputs): { state: ConnectState; message?: string; first_run: boolean; uin?: string; reason?: 'no_qq' | 'no_napcat' } {
  const { manager: m, onebot: o, qrcodeExists, uin, deepseekConfigured, isWindows } = input;
  const firstRun = uin === undefined || !deepseekConfigured;
  const napcatOk = input.napcatInstalled ?? true;

  if (input.externalOnebot) {
    // 外部 OneBot（Docker）：QQ 与 NapCat 都不在本机，只根据 WS 连接给出状态
    if (o.kicked) return { state: 'kicked', first_run: firstRun, uin };
    if (o.accountError) {
      // 持久化账号或挂库失败后 WS 可能已经主动断开，仍必须显示错误而不是假装重连中。
      return { state: 'error', message: MSG_ACCOUNT_DB, first_run: firstRun, uin };
    }
    if (o.wsConnected && o.selfId !== null) return { state: 'online', first_run: firstRun, uin };
    if (o.everOnline && !o.wsConnected) return { state: 'reconnecting', first_run: firstRun, uin };
    return { state: 'starting', first_run: firstRun, uin };
  }

  if (!isWindows) {
    // 00-总约定 §6：非 Windows 返回
    return { state: 'error', message: MSG_UNSUPPORTED, first_run: firstRun };
  }

  if (m.conflictAtBoot && m.pid === null) {
    // 启动时检测到 QQ.exe 在运行，尚未 spawn → 等用户点「关闭电脑版 QQ 并继续」
    return { state: 'qq_conflict', message: MSG_QQ_CONFLICT, first_run: firstRun };
  }
  if (m.napcatMissing) {
    return { state: 'error', message: MSG_NAPCAT_MISSING, first_run: firstRun, uin };
  }
  if (m.qqExe === null) {
    return { state: 'error', message: MSG_NO_QQ, first_run: firstRun, uin, reason: 'no_qq' }; // 没装 QQ
  }
  if (!napcatOk) {
    // 缺采集端运行包（git 克隆不带 napcat/）：给出带动作的文案（一键下载或手动放包）
    return { state: 'error', message: MSG_NO_NAPCAT, first_run: firstRun, uin, reason: 'no_napcat' };
  }
  if (m.crashLoop || m.spawnFailed) {
    // spawn 失败 / 进程 60s 内退出 ≥3 次（架构.md §7 反复崩溃文案）
    return { state: 'error', message: MSG_CRASH, first_run: firstRun, uin };
  }
  if (o.accountError) {
    return { state: 'error', message: MSG_ACCOUNT_DB, first_run: firstRun, uin };
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
  const deepseekConfigured = getLlmConfig().apiKey !== '';
  const external = EXTERNAL_ONEBOT; // Docker 等外部 OneBot 部署：不检查本机 QQ / NapCat 运行包
  const dataState = accountDataState();
  const onebot = getOnebotFacts();
  let derived = deriveConnectStatus({
    manager: getManagerFacts(),
    onebot: {
      ...onebot,
      accountError: onebot.accountError ?? (dataState === 'error' ? 'account database unavailable' : null),
    },
    qrcodeExists: existsSync(QRCODE_PATH),
    uin: getUin(),
    deepseekConfigured,
    isWindows: process.platform === 'win32',
    napcatInstalled: external ? true : existsSync(NAPCAT_BOOT_EXE),
    externalOnebot: external,
  });
  // lifecycle 已切成 B、数据库仍在等 A 的在途任务时，不得先向页面宣告 B online。
  if (dataState === 'switching' && derived.state === 'online') {
    derived = { ...derived, state: 'reconnecting' };
  }
  if (derived.state !== lastState) {
    lastState = derived.state;
    since = Date.now();
  }
  const dto: ConnectStatusDTO = {
    desktop_qq: getDesktopStatus(),
    state: derived.state,
    account_epoch: accountEpoch(),
    since,
    first_run: derived.first_run,
    deepseek_configured: deepseekConfigured,
  };
  if (derived.uin !== undefined) dto.uin = derived.uin;
  if (derived.message !== undefined) dto.message = derived.message;
  if (derived.reason !== undefined) dto.reason = derived.reason;
  if (legacyDataExists()) dto.legacy_data = true; // 旧版单库被迁到 accounts/legacy，前端提示一次
  if (derived.state === 'online') {
    const nick = getSelfNickname();
    if (nick !== null) dto.nickname = nick;
  }
  return dto;
}
