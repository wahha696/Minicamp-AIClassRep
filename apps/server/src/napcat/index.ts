// NapCat 采集端。主人是 A，完整实现见 A 的分工文件。
// startNapcat：写配置（架构.md §3 第 2 步）→ 冲突检测 / spawn / 监控（manager.ts）
//            → WS 客户端连接循环（onebot.ts，登录成功后 3001 才会开）。
// stopNapcat：同步结束进程树并停掉 WS 重连（B 的 index.ts 在 SIGINT/SIGHUP/exit 时调用，必须同步）。
import { writeNapcatConfig } from './config.js';
import { IS_WINDOWS, killTree, restart, startManager } from './manager.js';
import { resetAfterRestart, startOnebotClient, stopOnebotClient } from './onebot.js';

/** 拉起采集端（非 Windows 什么都不做，00-总约定 §6）。 */
export function startNapcat(): void {
  if (!IS_WINDOWS) return;
  writeNapcatConfig();
  startManager();
  startOnebotClient();
}

/** 结束采集端进程树（同步，用 execFileSync 调 taskkill，关窗口时也能执行）。 */
export function stopNapcat(): void {
  if (!IS_WINDOWS) return;
  stopOnebotClient();
  killTree();
}

/**
 * 「关闭电脑版 QQ 并继续 / 重新连接 / 重启采集端」共用入口（架构.md §5）：
 * manager.restart()（killTree → 杀 QQ.exe → 重新 spawn）完成后，复位 WS 侧的
 * kicked/退避状态并恢复连接循环。供 POST /api/connect/restart 调用。
 */
export async function restartNapcat(): Promise<void> {
  if (!IS_WINDOWS) return;
  await restart();
  resetAfterRestart();
}

export { IS_WINDOWS };
