import { getWechatIntake, selectWechatGroups, startWechatIntake, stopWechatIntake } from '../api/client';
import type { WechatCatalogDTO } from '../../../../shared/wechat';

/** A group switch is the explicit request to save and listen, including storage. */
export async function changeWechatListening(catalog: WechatCatalogDTO, epoch: string,
  changes: { source: string; enabled: boolean }[], isCurrent: () => boolean): Promise<void> {
  const offer = catalog.catalog, scope = catalog.scope;
  if (!offer || !scope || scope.account_epoch !== epoch || !isCurrent()) throw new Error('微信连接已变化，请刷新群列表');
  const previous = await getWechatIntake();
  if (!isCurrent() || (previous.scope && (previous.scope.account_epoch !== epoch
    || previous.scope.connection_id !== scope.connection_id))) throw new Error('微信连接已变化，请刷新群列表');
  if (previous.state === 'opening') throw new Error('正在启动微信监听，请稍候');
  const before = previous.collecting ? previous.groups.map(row => row.group_id) : [];
  const wanted = new Set(before);
  for (const change of changes) {
    if (!offer.groups.some(row => row.group_id === change.source)) throw new Error('群列表已变化，请刷新后重试');
    if (change.enabled) wanted.add(change.source); else wanted.delete(change.source);
  }
  if (wanted.size === before.length && before.every(group => wanted.has(group))) return;
  const select = (group_ids: string[]) => selectWechatGroups({ expected_account_epoch: epoch, catalog_id: offer.catalog_id, group_ids });
  const start = (group_ids: string[]) => startWechatIntake({ expected_account_epoch: epoch, connection_id: scope.connection_id,
    catalog_id: offer.catalog_id, group_ids, approve_key_read: true, approve_message_read: true, approve_selected_storage: true });
  let stopped = false, saved = false;
  try {
    if (previous.collecting && previous.intake_id) {
      await stopWechatIntake({ expected_account_epoch: epoch, intake_id: previous.intake_id }); stopped = true;
    }
    if (!isCurrent()) throw new Error('微信连接已变化，请刷新群列表');
    await select([...wanted]); saved = true;
    if (!isCurrent()) throw new Error('微信连接已变化，请刷新群列表');
    if (wanted.size) await start([...wanted]);
  } catch (error) {
    // Restore the previously running scope, never resume remembered but idle groups.
    if (isCurrent() && (stopped || saved)) {
      try { await select(before); if (before.length && isCurrent()) await start(before); }
      catch { throw new Error(`${error instanceof Error ? error.message : '监听启动失败'}；原有群监听也未能恢复，请检查微信后重试`); }
    }
    throw error;
  }
}
