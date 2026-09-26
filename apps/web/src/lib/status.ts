// 顶部状态灯 / 连接黄条的判定逻辑（纯函数，便于单测）。
// 文案来自 架构.md §4、§7 和 D-前端.md D1。页面上不许出现 "NapCat"，统一叫「采集端」「QQ 连接」。
import type { ConnectState, ConnectStatusDTO, HealthDTO } from '../api/types';

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
  error: '最近一次调用失败',
  unconfigured: '未配置',
};

/** health 为 undefined 表示读不到 /health（后端没开或断网） */
export function lightsFromHealth(health: HealthDTO | undefined): Light[] {
  const jev: Light = { key: 'jev', label: '快判', color: 'gray', tip: '快判层：预留，暂未启用' };
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

/** D5：首次看到 online 时弹一次「电脑版 QQ 已由 ClassRep 接管」，弹过就记下，不再弹 */
export const TAKEOVER_NOTICE_KEY = 'takeoverNoticeShown';
export const TAKEOVER_NOTICE_TEXT = '电脑版 QQ 已由 ClassRep 接管，聊天请用手机 QQ';

/** first_run 时把用户拦到 /connect；D5 里点「先用演示模式看看」会写 localStorage.skipConnect=1 放行 */
export function shouldRedirectToConnect(
  status: ConnectStatusDTO | undefined,
  pathname: string,
  skipConnect: boolean,
): boolean {
  return status?.first_run === true && pathname !== '/connect' && !skipConnect;
}
