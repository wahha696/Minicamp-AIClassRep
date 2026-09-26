// NapCat 采集端。主人是 A，完整实现见 A 的分工文件。
// startNapcat：写配置（架构.md §3 第 2 步）→ 冲突检测 / spawn / 监控（manager.ts）
//            → WS 客户端连接循环（onebot.ts，登录成功后 3001 才会开）。
// stopNapcat：同步结束进程树并停掉 WS 重连（B 的 index.ts 在 SIGINT/SIGHUP/exit 时调用，必须同步）。
import { writeNapcatConfig } from './config.js';
import { IS_WINDOWS, killTree, startManager } from './manager.js';
import { startOnebotClient, stopOnebotClient } from './onebot.js';

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

export { IS_WINDOWS };
