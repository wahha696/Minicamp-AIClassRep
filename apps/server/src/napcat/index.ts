// NapCat 采集端。主人是 A，完整实现见 A 的分工文件。
// startNapcat：探测空闲端口（B8）→ 写配置（架构.md §3 第 2 步）→ 冲突检测 / spawn / 监控（manager.ts）
//            → WS 客户端连接循环（onebot.ts，登录成功后端口才会开）。
// stopNapcat：同步结束进程树并停掉 WS 重连（B 的 index.ts 在 SIGINT/SIGHUP/exit 时调用，必须同步）。
import { deleteAccountData } from '../db/index.js';
import { NAPCAT_DIR } from '../paths.js';
import { newOnebotToken, writeNapcatConfig } from './config.js';
import { clearUin, getUin, IS_WINDOWS, killTree, napcatInstalled, restart, startManager } from './manager.js';
import { pickFreePort, resetAfterRestart, setOnebotEndpoint, startOnebotClient, stopOnebotClient } from './onebot.js';

/** 拉起采集端（非 Windows 什么都不做，00-总约定 §6）。 */
export async function startNapcat(): Promise<void> {
  if (!IS_WINDOWS) return;
  // napcat/ 不完整时不写配置（否则会建出半截目录），manager 会把状态置为「采集组件缺失」
  if (napcatInstalled()) {
    // B8：3001 可能被别的 OneBot 实例占用——探测空闲端口，写进配置，onebot 连同一个
    const port = await pickFreePort(3001);
    setOnebotEndpoint(writeNapcatConfig(NAPCAT_DIR, newOnebotToken(), port), port);
  }
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
 * 「关闭电脑版 QQ 并继续 / 重新连接 / 重启采集端」共用入口（架构.md §5）。
 * killUserQQ=true 只由「关闭电脑版 QQ 并继续」按钮传入（修复计划 S4）。
 */
export async function restartNapcat(opts: { killUserQQ?: boolean } = {}): Promise<void> {
  if (!IS_WINDOWS) return;
  await restart(opts);
  resetAfterRestart();
}

/**
 * 退出登录：忘掉记住的 QQ 号 → 重启采集端（不带 -q）→ 页面回到扫码。
 * 数据按 QQ 号分库保存（data/accounts/<uin>/），换号不会串数据，换回来原样恢复。
 * erase=true（「退出并删除本号数据」危险选项）：把 accounts/<uin>/ 整个删掉，无法恢复。
 */
export async function logoutNapcat(opts: { erase?: boolean } = {}): Promise<void> {
  const uin = getUin();
  clearUin();
  if (opts.erase === true && uin !== undefined) deleteAccountData(uin);
  if (!IS_WINDOWS) return;
  await restart();
  resetAfterRestart();
}

export { IS_WINDOWS };
