// 顶部状态灯 / 连接黄条的判定逻辑（纯函数，便于单测）。
// 文案来自 架构.md §4、§7 和 D-前端.md D1。页面上不许出现 "NapCat"，统一叫「采集端」「QQ 连接」。
import type { ConnectState, ConnectStatusDTO, HealthDTO } from '../api/types';
import { accountKey } from './account';

// ===== 状态灯

export type LightColor = 'green' | 'red' | 'gray';

export interface Light {
  key: 'qq' | 'db' | 'llm' | 'jev';
  label: string;
  color: LightColor;
  tip: string; // 悬停说明
}

export const QQ_STATE_TEXT: Record<ConnectState, string> = {
  online: '已连接，正在接收群消息',
  starting: '正在登录 QQ…',
  waiting_qr: '等待手机 QQ 扫码登录',
  qq_conflict: '电脑版 QQ 正开着，等待接管',
  reconnecting: '连接中断，重连中',
  kicked: '你的 QQ 在另一台电脑登录了，采集已暂停',
  error: '采集端异常',
};

const LLM_TEXT: Record<HealthDTO['llm'], string> = {
  ok: '正常',
  error: '最近一次连不上 AI 服务（检查网络或 API Key），消息会保留，1 分钟后自动重试',
  unconfigured: '未配置',
};

/** 快判灯：jev/local/dual 三种模式共用，标签与悬停说明标出实际后端 */
function jevLight(health: HealthDTO | undefined): Light {
  if (!health) return { key: 'jev', label: '快判', color: 'gray', tip: '快判：状态未知' };
  if (health.jev === 'disabled') return { key: 'jev', label: '快判', color: 'gray', tip: '快判：已关闭' };

  const mode = health.jev_mode;
  const label = mode === 'local' ? '本地快判' : mode === 'dual' ? '双路快判' : '快判';
  const via = mode === 'local'
    ? '本地模型'
    : mode === 'dual'
      ? `远端 Jev + 本地模型（路由=${health.jev_route === 'local' ? '本地' : '远端'}）`
      : '远端 Jev';

  if (health.jev === 'ok') {
    const backoffNote = health.jev_local === 'backoff' ? '；本地模型退避中' : '';
    return { key: 'jev', label, color: 'green', tip: `快判（${via}）：正常${backoffNote}` };
  }
  const tip = health.jev === 'unconfigured'
    ? mode === 'local'
      ? '本地快判：模型未就绪（检查 FASTJUDGE_ROOT / 模型路径），消息仍由 AI 处理'
      : mode === 'dual'
        ? '双路快判：远端 key 与本地模型均未配置，消息仍由 AI 处理'
        : 'Jev 快判：未配置 TypeSafe API Key，消息仍由 AI 处理'
    : `快判（${via}）：最近一次调用失败，消息已交给 AI 处理`;
  return { key: 'jev', label, color: 'red', tip };
}

/** health 为 undefined 表示读不到 /health（后端没开或断网） */
export function lightsFromHealth(health: HealthDTO | undefined): Light[] {
  // P3：health 读不到时 Jev 是「未知」，不是「已关闭」
  const jev = jevLight(health);
  if (!health) {
    const down = '无法连接到 ClassRep，请确认启动窗口没有关闭';
    return [
      { key: 'qq', label: 'QQ', color: 'red', tip: `QQ 连接：${down}` },
      { key: 'db', label: '数据库', color: 'red', tip: `数据库：${down}` },
      { key: 'llm', label: 'AI', color: 'red', tip: `AI：${down}` },
      jev,
    ];
  }
  return [
    {
      key: 'qq',
      label: 'QQ',
      color: health.qq === 'online' ? 'green' : 'red',
      tip: `QQ 连接：${QQ_STATE_TEXT[health.qq] ?? health.qq}`,
    },
    {
      key: 'db',
      label: '数据库',
      color: health.db === 'ok' ? 'green' : 'red',
      tip: `数据库：${health.db === 'ok' ? '正常' : '异常'}`,
    },
    {
      key: 'llm',
      label: 'AI',
      color: health.llm === 'ok' ? 'green' : 'red',
      tip: `AI：${LLM_TEXT[health.llm] ?? health.llm}`,
    },
    jev,
  ];
}

// ===== 连接黄条

export const ERROR_FALLBACK = '采集端异常。常见原因是 QQ 版本过旧，请更新到最新版 QQ 后重试';
export const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq';

export type Banner =
  | { kind: 'reconnecting'; text: string }
  | { kind: 'kicked'; text: string; action: 'restart'; actionText: string }
  | { kind: 'error'; text: string; action: 'restart'; actionText: string }
  | { kind: 'not_connected'; text: string; linkTo: '/connect'; linkText: string };

/** 返回 null 表示不显示黄条 */
export function bannerFor(status: ConnectStatusDTO | undefined, pathname: string): Banner | null {
  if (!status) return null;
  switch (status.state) {
    case 'reconnecting':
      return { kind: 'reconnecting', text: '连接中断，重连中' };
    case 'kicked':
      return {
        kind: 'kicked',
        text: '你的 QQ 在另一台电脑登录了，采集已暂停',
        action: 'restart',
        actionText: '重新连接',
      };
    case 'error':
      return {
        kind: 'error',
        text: status.message || ERROR_FALLBACK,
        action: 'restart',
        actionText: '重启采集端',
      };
    case 'qq_conflict':
    case 'waiting_qr':
    case 'starting':
      if (pathname === '/connect') return null;
      return { kind: 'not_connected', text: 'QQ 未连接', linkTo: '/connect', linkText: '去连接' };
    case 'online':
      return null;
  }
}

// ===== 路由守卫

export const SKIP_CONNECT_KEY = 'skipConnect';
/** 值为 '1'：勾选待办时不再弹「是否确认完成」 */
export const SKIP_DONE_CONFIRM_KEY = 'skipTodoDoneConfirm';

/** localStorage 读写（隐私模式 / 禁用站点数据时会抛错）：读失败当没有，写失败静默忽略 */
export function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下就只在本次生效
  }
}

/** 账号限定的旗标（修复计划第一节 §4）：换号后读写另一套键，互不干扰 */
export function readAccountFlag(key: string): string | null {
  return readFlag(accountKey(key));
}
export function writeAccountFlag(key: string, value: string): void {
  writeFlag(accountKey(key), value);
}

/** D5：首次看到 online 时弹一次「电脑版 QQ 已由 ClassRep 接管」，弹过就记下，不再弹 */
export const TAKEOVER_NOTICE_KEY = 'takeoverNoticeShown';
export const TAKEOVER_NOTICE_TEXT = '电脑版 QQ 已由 ClassRep 接管，聊天请用手机 QQ';

/** 旧版单库迁移提示：用户点「知道了」后不再显示 */
export const LEGACY_DATA_KEY = 'legacyDataNoticeShown';

/** first_run 时把用户拦到 /setup 向导（填 Key → 扫码）；向导页自己也允许跳过（演示模式） */
export function shouldRedirectToConnect(
  status: ConnectStatusDTO | undefined,
  pathname: string,
  skipConnect: boolean,
): boolean {
  return status?.first_run === true && pathname !== '/setup' && pathname !== '/connect' && !skipConnect;
}
