import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WechatCatalogDTO, WechatConnectionDTO } from '../../../../shared/wechat';
import type { WechatUnavailableReason } from '../../../../shared/workspaces';
import { connectWechat, disconnectWechat, getWechatGroups, getWechatStatus, refreshWechatGroups, selectWechatGroups } from '../api/client';
import WechatMessagesPanel from './WechatMessagesPanel';
import { loadWechatDataRoot, saveWechatDataRoot, validWechatDataRoot } from '../lib/wechat-data-root';
import { wechatErrorText } from '../lib/wechat-errors';
const button = 'rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40';
const emptyCatalog: WechatCatalogDTO = { state: 'idle', error: null, collecting: false, scope: null, catalog: null, selected_group_ids: [] };

/** Mounting a disabled/remote panel never calls even a status endpoint.
 */
export default function WechatPanel({ available, unavailableReason, local, epoch, account, installationId, onChanged, mode = 'connection', renderGroups }: {
  available: boolean; unavailableReason?: WechatUnavailableReason;
  mode?: 'connection' | 'groups';
  renderGroups?: (catalog: WechatCatalogDTO, reload: () => Promise<void>) => ReactNode;
  local: boolean; epoch: string; account?: string; installationId?: string; onChanged(): Promise<unknown> | void;
}) {
  const title = mode === 'groups' ? '微信采集' : '微信连接';
  if (!available) return <section aria-label={title} className="space-y-3 border-t border-slate-200 pt-5 text-left">
    <h3 className="font-semibold text-slate-800">{title}</h3>
    <p className="text-sm text-slate-500" role="status">{unavailableReason === 'platform_unsupported'
      ? '微信采集目前仅支持 Windows 电脑。'
      : unavailableReason === 'runtime_missing'
        ? wechatErrorText('WECHAT_RUNTIME_MISSING')
        : '微信连接暂不可用，请重启课代表后重试。'}</p>
    {mode === 'connection' && <button type="button" disabled className={button}>连接电脑微信</button>}
    {mode === 'groups' && renderGroups?.(emptyCatalog, async () => {})}
  </section>;
  if (!local) return <section aria-label={title} className="space-y-3 border-t border-slate-200 pt-5">
    <h3 className="font-semibold text-slate-800">{title}</h3>
    <p className="text-sm text-slate-500">请在电脑本机管理微信连接和所选群。</p>
    {mode === 'groups' && renderGroups?.(emptyCatalog, async () => {})}
  </section>;
  return <LocalWechatPanel key={JSON.stringify([epoch, mode, account, installationId])} epoch={epoch} account={account} installationId={installationId} onChanged={onChanged} mode={mode} renderGroups={renderGroups} />;
}

function LocalWechatPanel({ epoch, account, installationId, onChanged, mode, renderGroups }: { epoch: string; account?: string; installationId?: string; onChanged(): Promise<unknown> | void; mode: 'connection' | 'groups'; renderGroups?: (catalog: WechatCatalogDTO, reload: () => Promise<void>) => ReactNode }) {
  const [connection, setConnection] = useState<WechatConnectionDTO | null>(null);
  const [catalog, setCatalog] = useState<WechatCatalogDTO | null>(null);
  const [identityConsent, setIdentityConsent] = useState(false);
  const [catalogConsent, setCatalogConsent] = useState(false);
  const [dataRoot, setDataRoot] = useState(() => mode === 'groups' ? loadWechatDataRoot(installationId, account) : '');
  const [restoredPath, setRestoredPath] = useState(() => mode === 'groups' && !!loadWechatDataRoot(installationId, account));
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const alive = useRef(true);
  const source = useRef<string | null>(null);
  const offerId = useRef<string | null>(null);
  const draft = useRef(false);
  const loading = useRef<Promise<void> | null>(null);

  async function readState() {
    const next = await getWechatStatus();
    if (!alive.current) return;
    setReadError('');
    if (source.current !== next.connection_id || next.state !== 'identified') {
      ++generation.current; setCatalog(null); setPicked([]); offerId.current = null; draft.current = false;
      setCatalogConsent(false); setNotice('');
    }
    source.current = next.connection_id; setConnection(next);
    if (next.state !== 'identified' || mode === 'connection') return;
    const expectedSource = next.connection_id;
    const current = await getWechatGroups();
    if (!alive.current || source.current !== expectedSource) return;
    if (!current.scope || current.scope.connection_id !== expectedSource || current.scope.account_epoch !== epoch) {
      setCatalog(null); setPicked([]); offerId.current = null; draft.current = false; return;
    }
    setCatalog(current);
    if (offerId.current !== current.catalog?.catalog_id || !draft.current) {
      if (offerId.current !== current.catalog?.catalog_id) draft.current = false;
      offerId.current = current.catalog?.catalog_id ?? null;
      setPicked(current.selected_group_ids);
    }
  }

  function load(): Promise<void> {
    // Polling and button completion share one state read; no older response
    // can overwrite a new connection/catalog response.
    if (loading.current) return loading.current;
    const pending = readState(); loading.current = pending;
    void pending.finally(() => { if (loading.current === pending) loading.current = null; }).catch(() => {});
    return pending;
  }

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await load(); } catch (caught) {
        if (alive.current) {
          ++generation.current; source.current = null; offerId.current = null; draft.current = false;
          setConnection(null); setCatalog(null); setPicked([]); setNotice('');
          setReadError(caught instanceof Error ? caught.message : '连接状态暂时无法读取，请稍后重试。');
        }
      }
      if (alive.current) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { alive.current = false; ++generation.current; clearTimeout(timer); };
  }, [epoch]);

  async function act(work: () => Promise<unknown>, success = '') {
    const current = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await work();
      if (!alive.current || current !== generation.current) return;
      if (success) setNotice(success);
      await load();
      if (alive.current) await onChanged();
    } catch (caught) {
      if (alive.current && current === generation.current) setError(caught instanceof Error ? caught.message : '操作失败，请重试。');
    } finally { if (alive.current) setBusy(false); }
  }
  const offer = catalog?.catalog;
  const reading = catalog?.state === 'reading' || catalog?.state === 'stopping';
  const matched = offer?.groups.filter((group) => `${group.name ?? ''} ${group.group_id}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const selectionDirty = !!catalog && (picked.length !== catalog.selected_group_ids.length || picked.some(id => !catalog.selected_group_ids.includes(id)));

  return <section aria-label={mode === 'groups' ? '微信采集' : '微信连接'} className="space-y-4 border-t border-slate-200 pt-5 text-left">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-slate-900">{mode === 'groups' ? '微信采集' : '微信连接'}</h3>
      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">读取适配基线：4.1.15.50 指定构建</span>
    </div>
    {connection?.state === 'identified' && <p className="break-all text-sm text-slate-600">
      {connection?.state === 'identified' && connection.nickname?.trim() || '微信用户'}
    </p>}
    {connection?.error && connection.state !== 'identified' && <p role="alert" className="text-sm text-rose-600">{wechatErrorText(connection.error)}</p>}
    {!connection ? <p className="text-sm text-slate-500">{readError ? '连接状态暂时无法读取，将自动重试状态检查。' : '正在核对连接状态…'}</p> : connection.state !== 'identified' && mode === 'groups' ? <>
      <p className="text-sm text-slate-600">微信尚未连接。</p>
      <Link to="/connect" className="text-sm text-blue-600 underline">连接微信</Link>
    </> : connection.state !== 'identified' ? <>
      <p className="text-sm text-slate-600">先登录电脑微信，再连接课代表。</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={identityConsent} disabled={busy}
        onChange={(event) => setIdentityConsent(event.target.checked)} />
        <span>允许本机持续核对微信账号与登录状态，退出或换号即停止；账号不上传。</span></label>
      <button type="button" className={button} disabled={!identityConsent || busy || connection.state === 'connecting'}
        onClick={() => void act(() => connectWechat(epoch))}>{busy || connection.state === 'connecting' ? '正在连接…' : '连接电脑微信'}</button>
    </> : <>
      <div className="flex items-center justify-between gap-3"><p className="text-sm text-emerald-700">微信账号已识别</p>
        {mode === 'connection' && <button type="button" className="text-sm text-slate-600 underline disabled:opacity-40" disabled={busy}
          onClick={() => void act(() => disconnectWechat(epoch, connection.connection_id))}>断开微信</button>}</div>
      {mode === 'connection' ? <Link to="/groups?platform=wechat" className="inline-block text-sm text-blue-600 underline">管理微信群</Link>
        : <p className="text-sm text-slate-600">{catalog ? '只采集主动选择的群。首次启用不补历史。' : '正在核对群目录，请稍候。'}</p>}
      {catalog && <>
        <details open={!offer} className="rounded-xl border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">{offer ? '更新群列表' : '读取群列表'}</summary>
        <div className="mt-3 space-y-3">
        <label className="block space-y-1 text-sm">微信存储位置
          <input aria-label="微信存储位置" value={dataRoot} disabled={busy || reading} maxLength={4096}
            onChange={(event) => {
              setDataRoot(event.target.value); setCatalogConsent(false); setRestoredPath(false);
              saveWechatDataRoot(installationId, account, event.target.value);
            }} placeholder="以 xwechat_files 结尾，可从微信复制：设置 → 账号与存储 → 存储位置"
            className="w-full rounded-lg border border-slate-300 p-2" /></label>
        <p className="text-xs text-slate-500">{restoredPath
          ? '已回填此浏览器为当前安装和账号保存的路径。路径不来自仓库，也不代表已授权读取。'
          : installationId && account ? '有效路径仅在此浏览器按当前安装和账号保存；读取仍需单独允许。'
            : '尚未确认安装或账号身份，路径不会保存；你仍可手动输入。'}</p>
        {dataRoot && <button type="button" className="text-xs text-slate-600 underline disabled:opacity-40" disabled={busy || reading}
          onClick={() => { setDataRoot(''); setRestoredPath(false); setCatalogConsent(false); saveWechatDataRoot(installationId, account, ''); }}>
          清除当前路径记忆</button>}
        {dataRoot.trim() && !validWechatDataRoot(dataRoot.trim()) && <p role="alert" className="text-sm text-rose-600">请输入以 xwechat_files 结尾的完整 Windows 路径。</p>}
        <label className="flex items-start gap-2 text-sm"><input aria-label="允许读取微信群目录" type="checkbox" checked={catalogConsent} disabled={busy || reading}
          onChange={(event) => setCatalogConsent(event.target.checked)} />
          <span>允许查找当前账号目录、内存解密联系人库，仅返回群名、群 ID 和本人昵称。可能接触其他联系人页；密钥和完整明文库不保存、不上传。</span></label>
        <button type="button" className={button} disabled={busy || reading || !catalogConsent || !validWechatDataRoot(dataRoot.trim())}
          onClick={() => void act(() => refreshWechatGroups({ expected_account_epoch: epoch, data_root: dataRoot.trim(), approve_key_read: true, approve_contact_read: true }))}>
          {reading || busy ? '正在处理，请稍候…' : '读取群列表'}</button>
        {catalog.state === 'error' && <p role="alert" className="text-sm text-rose-600">{wechatErrorText(catalog.error, 'catalog')}</p>}
        </div></details>
        {offer && <>
          {!renderGroups && <>
          <input aria-label="搜索微信群" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索群名或群 ID"
            className="w-full rounded-lg border border-slate-300 p-2 text-sm" />
          <p className="text-sm text-slate-500">共 {offer.groups.length} 个群，已选 {picked.length} 个。相同群名请核对群 ID。</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {matched.map((group) => <label key={group.group_id} className="flex items-start gap-2 rounded-lg border border-slate-100 p-2 text-sm">
              <input type="checkbox" disabled={busy || reading} checked={picked.includes(group.group_id)}
                onChange={(event) => { draft.current = true; setPicked((previous) => event.target.checked ? [...previous, group.group_id] : previous.filter((id) => id !== group.group_id)); }} />
              <span className="min-w-0 break-words">{group.name || '未命名群'}<span className="block break-all text-xs text-slate-400">{group.group_id}</span></span>
            </label>)}
          </div>
          {!matched.length && <p className="text-sm text-slate-500">{offer.groups.length ? '没有匹配的群。' : '当前账号没有可选微信群。'}</p>}
          <button type="button" className={button} disabled={busy || reading || !selectionDirty}
            onClick={() => void act(async () => {
              const result = await selectWechatGroups({ expected_account_epoch: epoch, catalog_id: offer.catalog_id, group_ids: picked });
              if (alive.current && source.current === connection.connection_id && offerId.current === offer.catalog_id) {
                draft.current = false; setPicked(result.selected_group_ids);
              }
            }, '所选群已确认。')}>确认所选群</button>
          </>}
          {connection.connection_id && <WechatMessagesPanel
            key={`${epoch}:${connection.connection_id}:${offer.catalog_id}:${catalog.selected_group_ids.slice().sort().join(',')}`}
            epoch={epoch} connectionId={connection.connection_id} catalogId={offer.catalog_id}
            groups={offer.groups.filter((row) => catalog.selected_group_ids.includes(row.group_id))}
            selectionDirty={selectionDirty} />}
        </>}
      </>}
    </>}
    {mode === 'groups' && renderGroups?.(catalog ?? emptyCatalog, async () => { await load(); await load(); })}
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer">兼容与读取说明</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
        <li>当前适配 Windows x64 微信 4.1.15.50 的指定程序构建；还会核对实际模块，版本号相同也可能有不同构建。</li>
        <li>读取依赖版本对应的程序结构，旧版不一定更兼容。微信 3.x 和其他 4.x 尚需独立适配，请勿仅凭一次连接失败升降级微信。</li>
        <li>未登录、多个实例、进程权限、组件或依赖缺失会分别提示；普通连接失败不等于版本不支持。</li>
        <li>不自动回复，不点击或切换微信窗口。</li>
        <li>选择保存在当前空间。断开保留数据，QQ 可继续使用。</li>
      </ul>
    </details>
    {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
    {readError && <p role="alert" className="text-sm text-rose-600">{readError}</p>}
    {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
  </section>;
}
