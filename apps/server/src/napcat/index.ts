// NapCat 采集端。主人是 A，完整实现见 A 的分工文件。
// startNapcat：探测空闲端口（B8）→ 写配置（架构.md §3 第 2 步）→ 冲突检测 / spawn / 监控（manager.ts）
//            → WS 客户端连接循环（onebot.ts，登录成功后端口才会开）。
// stopNapcat：同步结束进程树并停掉 WS 重连（B 的 index.ts 在 SIGINT/SIGHUP/exit 时调用，必须同步）。
// 外部 OneBot 模式（Docker，ONEBOT_WS_URL 指向远端）：不写配置、不 spawn QQ 注入，只起 WS 客户端。
import { closeCurrentAccount, deleteAccountData } from '../accounts.js';
import { NAPCAT_DIR } from '../paths.js';
import { newOnebotToken, writeNapcatConfig } from './config.js';
import { clearUin, getUin, IS_WINDOWS, killTree, napcatInstalled, restart, startManager } from './manager.js';
import {
  EXTERNAL_ONEBOT,
  pickFreePort,
  resetAfterRestart,
  setOnebotEndpoint,
  startOnebotClient,
  stopOnebotClient,
} from './onebot.js';

/** 本机注入模式：Windows 且没配 ONEBOT_WS_URL。Docker / 非 Windows 用外部 OneBot 服务。 */
const LOCAL_INJECT = IS_WINDOWS && !EXTERNAL_ONEBOT;

/** 拉起采集端：本机注入模式拉起 QQ + NapCat；外部模式只连 ONEBOT_WS_URL。 */
export async function startNapcat(): Promise<void> {
  if (!LOCAL_INJECT) {
    startOnebotClient(); // Docker/外部 NapCat：只连 WS，登录状态由 NapCat 侧自己维持
    return;
  }
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
  if (!LOCAL_INJECT) {
    stopOnebotClient();
    return;
  }
  stopOnebotClient();
  killTree();
}

/**
 * 「关闭电脑版 QQ 并继续 / 重新连接 / 重启采集端」共用入口（架构.md §5）。
 * killUserQQ=true 只由「关闭电脑版 QQ 并继续」按钮传入（修复计划 S4）。
 * 外部模式没有进程可管，只复位 WS 重连。
 */
export async function restartNapcat(opts: { killUserQQ?: boolean } = {}): Promise<void> {
  if (!LOCAL_INJECT) {
    resetAfterRestart();
    return;
  }
  await restart(opts);
  resetAfterRestart();
}

/**
 * 退出登录（连接页右侧账号卡片的「退出登录」）：忘掉记住的 QQ 号 → 静默流水线并切回
 * 「无账号」兜底库（该账号的数据完整保留在 data/accounts/<uin>/，换号登录互不可见）
 * → 本机注入模式按 restart 流程关掉采集端和 QQ 再重新拉起（不带 -q，不会快速登录）→ 页面回到扫码。
 * erase=true（「退出并删除本号数据」危险选项）：把 accounts/<uin>/ 整个删掉，无法恢复。
 */
export async function logoutNapcat(opts: { erase?: boolean } = {}): Promise<void> {
  const uin = getUin();
  clearUin();
  try {
    if (opts.erase === true && uin !== undefined) {
      // deleteAccountData 会先 closeCurrentAccount 再删目录
      await deleteAccountData(uin);
    } else {
      await closeCurrentAccount();
    }
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
