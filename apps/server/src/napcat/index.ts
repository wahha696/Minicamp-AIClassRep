// NapCat 采集端。主人是 A，完整实现见 A 的分工文件。
// startNapcat：写配置（架构.md §3 第 2 步）→ 冲突检测 / spawn / 监控（manager.ts）
//            → WS 客户端连接循环（onebot.ts，登录成功后 3001 才会开）。
// stopNapcat：同步结束进程树并停掉 WS 重连（B 的 index.ts 在 SIGINT/SIGHUP/exit 时调用，必须同步）。
// 外部 OneBot 模式（Docker，ONEBOT_WS_URL 指向远端）：不写配置、不 spawn QQ 注入，只起 WS 客户端。
import { writeNapcatConfig } from './config.js';
import { closeCurrentAccount } from '../accounts.js';
import { clearUin, IS_WINDOWS, killTree, restart, startManager } from './manager.js';
import { resetAfterRestart, startOnebotClient, stopOnebotClient, EXTERNAL_ONEBOT } from './onebot.js';

/** 本机注入模式：Windows 且没配 ONEBOT_WS_URL。Docker / 非 Windows 用外部 OneBot 服务。 */
const LOCAL_INJECT = IS_WINDOWS && !EXTERNAL_ONEBOT;

/** 拉起采集端：本机注入模式拉起 QQ + NapCat；外部模式只连 ONEBOT_WS_URL。 */
export function startNapcat(): void {
  if (!LOCAL_INJECT) {
    startOnebotClient(); // Docker/外部 NapCat：只连 WS，登录状态由 NapCat 侧自己维持
    return;
  }
  writeNapcatConfig();
  startManager();
  startOnebotClient();
}

/** 结束采集端进程树（同步，用 execFileSync 调 taskkill，关窗口时也能执行）。 */
export function stopNapcat(): void {
  if (!LOCAL_INJECT) {
    stopOnebotClient();
    return;
  }
  stopOnebotClient();
  killTree();
}

/**
 * 「关闭电脑版 QQ 并继续 / 重新连接 / 重启采集端」共用入口（架构.md §5）：
 * manager.restart()（killTree → 杀 QQ.exe → 重新 spawn）完成后，复位 WS 侧的
 * kicked/退避状态并恢复连接循环。供 POST /api/connect/restart 调用。
 * 外部模式没有进程可管，只复位 WS 重连。
 */
export async function restartNapcat(): Promise<void> {
  if (!LOCAL_INJECT) {
    resetAfterRestart();
    return;
  }
  await restart();
  resetAfterRestart();
}

/**
 * 退出登录（连接页右侧账号卡片的「退出登录」）：忘掉记住的 QQ 号 → 静默流水线并切回
 * 「无账号」兜底库（该账号的数据完整保留在 data/accounts/<uin>/，换号登录互不可见）
 * → 本机注入模式按 restart 流程关掉采集端和 QQ 再重新拉起（不带 -q，不会快速登录）→ 页面回到扫码。
 */
export async function logoutNapcat(): Promise<void> {
  clearUin();
  try {
    await closeCurrentAccount();
  } catch (e) {
    // 关库失败不挡登出（下个账号 lifecycle 会再切一次）
    console.warn('[napcat] 登出时关闭账号库失败：', e);
  }
  if (!LOCAL_INJECT) {
    resetAfterRestart();
    return;
  }
  await restart();
  resetAfterRestart();
}

export { IS_WINDOWS };
