import { accountDataState, accountEpoch, currentAccount } from '../accounts.js';
import { cancelHistorySync } from '../ingest/history.js';
import { desktopPipelineEpoch, setDesktopPipelinePaused } from '../pipeline/activity.js';
import { DesktopSession } from './desktop-session.js';
import { ensureDesktopQQExited, openDesktopQQ } from './desktop-process.js';
import { setDesktopRecoveryDoneHandler, setDesktopRecoveryHandler, setDesktopStatusProvider } from './desktop-recovery.js';
import { IS_WINDOWS, getManagerFacts, killTree, restart } from './manager.js';
import { EXTERNAL_ONEBOT, isOnline, resetAfterRestart, stopOnebotClient } from './onebot.js';

export const desktopSession = new DesktopSession({
  supported: IS_WINDOWS && !EXTERNAL_ONEBOT,
  account: () => ({ epoch: accountEpoch(), uin: currentAccount(), online: isOnline(), ready: accountDataState() === 'ready' }),
  pause: () => {
    setDesktopPipelinePaused(true);
    cancelHistorySync();
    stopOnebotClient();
    killTree();
  },
  openQQ: openDesktopQQ,
  resume: async () => {
    await ensureDesktopQQExited();
    await restart();
    const facts = getManagerFacts();
    if (facts.pid === null || facts.spawnFailed) throw new Error('采集端未能启动，请检查 QQ 后重试');
    resetAfterRestart();
  },
});

let backfill: { uin: string; since: number; epoch: number } | null = null;
setDesktopRecoveryHandler((uin) => {
  const since = desktopSession.onOnline(uin);
  // Ingest the gap before processing new messages, preserving notice order.
  if (since !== null) backfill = { uin, since, epoch: desktopPipelineEpoch() };
  return since;
});
setDesktopRecoveryDoneHandler((uin, since) => {
  if (!backfill || backfill.uin !== uin || backfill.since !== since) return;
  if (!desktopSession.isActive() && desktopPipelineEpoch() === backfill.epoch) {
    setDesktopPipelinePaused(false);
  }
  backfill = null;
});
setDesktopStatusProvider(() => desktopSession.getStatus());
