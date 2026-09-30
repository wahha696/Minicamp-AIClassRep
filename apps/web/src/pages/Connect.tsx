// 连接页 /connect（D5，架构.md §4、§7）：按连接状态显示扫码 / 接管 QQ / 异常 / 加载。
// 状态来自全局 ConnectStatusProvider（每 2s 轮询），这里不再单独轮询。
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  deleteAccountData,
  getFetchNapcatProgress,
  listAccounts,
  logoutConnect,
  qrcodeUrl,
  restartConnect,
  startFetchNapcat,
} from '../api/client';
import type { AccountsDTO, ConnectStatusDTO, SetupProgressDTO } from '../api/types';
import AiSettingsCard from '../components/AiSettingsCard';
import { qqAvatarUrl } from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import { useConnectStatus } from '../components/ConnectStatus';
import { useToast } from '../components/Toast';
import { toastError } from '../lib/errors';
import {
  ERROR_FALLBACK,
  LEGACY_DATA_KEY,
  QQ_DOWNLOAD_URL,
  SKIP_CONNECT_KEY,
  TAKEOVER_NOTICE_KEY,
  TAKEOVER_NOTICE_TEXT,
  readAccountFlag,
  readFlag,
  writeAccountFlag,
  writeFlag,
} from '../lib/status';

export default function Connect() {
  const { data, error, refresh } = useConnectStatus();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);

  const state = data?.state;

  // online：不再自动跳走（这页还有「AI 接入」要配）；这个号第一次看到 online 时弹一次接管提示
  useEffect(() => {
    if (state === 'online' && readAccountFlag(TAKEOVER_NOTICE_KEY) !== '1') setNotice(true);
  }, [state]);

  function closeNotice() {
    writeAccountFlag(TAKEOVER_NOTICE_KEY, '1');
    setNotice(false);
  }

  async function onRestart(killQQ = false) {
    if (!data) return;
    const context = { accountEpoch: data.account_epoch, uin: data.uin ?? null };
    setBusy(true);
    try {
      await restartConnect(context, killQQ);
      await refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  function goDemo() {
    writeAccountFlag(SKIP_CONNECT_KEY, '1');
    navigate('/demo');
  }

  let body: ReactNode;
  if (!data) {
    body = error ? (
      <Panel title={error.message} />
    ) : (
      <Spinner text="正在读取连接状态…" />
    );
  } else {
    switch (data.state) {
      case 'starting':
        body = <Spinner text="正在登录 QQ…" />;
        break;
      case 'waiting_qr':
        body = <QrCode />;
        break;
      case 'qq_conflict':
        body = (
          <Panel title="ClassRep 需要接管电脑版 QQ，期间请用手机 QQ 聊天">
            <BigButton onClick={() => void onRestart(true)} busy={busy}>
              关闭电脑版 QQ 并继续
            </BigButton>
            <p className="mt-3 text-xs text-slate-400">关闭前请确认电脑版 QQ 里没有正在发送的消息</p>
          </Panel>
        );
        break;
      case 'error':
        body = (
          <Panel title={data.message || ERROR_FALLBACK} tone="error">
            {data.reason === 'no_napcat' && <NapcatDownload onInstalled={refresh} />}
            <div className="flex flex-wrap justify-center gap-3">
              <BigButton onClick={onRestart} busy={busy}>
                重启采集端
              </BigButton>
              {data.reason !== 'no_napcat' && (
                <a
                  href={QQ_DOWNLOAD_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-slate-300 px-6 py-3 text-base font-medium text-slate-700 hover:bg-slate-50"
                >
                  下载最新版 QQ
                </a>
              )}
            </div>
          </Panel>
        );
        break;
      case 'kicked':
        body = (
          <Panel title="你的 QQ 在另一台电脑登录了，采集已暂停">
            <BigButton onClick={onRestart} busy={busy}>
              重新连接
            </BigButton>
          </Panel>
        );
        break;
      case 'reconnecting':
        body = <Spinner text="连接中断，重连中" />;
        break;
      case 'online':
        body = (
          <Panel title={`✅ QQ 已连接${data.uin ? `（${data.uin}）` : ''}，正在接收群消息`}>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="rounded-xl bg-slate-900 px-6 py-3 text-base font-medium text-white hover:bg-slate-700"
            >
              查看今日日程 →
            </button>
          </Panel>
        );
        break;
    }
  }

  const showAccount = !!data?.uin && state !== 'waiting_qr';

  return (
    <div className={`mx-auto py-6 ${showAccount ? 'max-w-3xl md:flex md:items-start md:gap-8' : 'max-w-md'}`}>
    {showAccount && data && <AccountCard status={data} onLoggedOut={refresh} />}
    <section className="mx-auto w-full max-w-md space-y-8 text-center md:order-first">
      <div aria-live="polite">
        <h2 className="mb-3 text-left text-sm font-semibold text-slate-500">QQ 连接</h2>
        {body}
        {state !== 'online' && (
          <button
            type="button"
            onClick={goDemo}
            className="mt-6 text-sm text-slate-400 underline-offset-4 hover:text-slate-600 hover:underline"
          >
            没有 QQ？先用演示模式看看 →
          </button>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-left text-sm font-semibold text-slate-500">AI 接入</h2>
        <AiSettingsCard />
      </div>

      {data?.legacy_data && readFlag(LEGACY_DATA_KEY) !== '1' && (
        <LegacyDataNotice onDismiss={() => writeFlag(LEGACY_DATA_KEY, '1')} />
      )}

      <AccountsCard />

      {notice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="text-4xl" aria-hidden>
              ✅
            </div>
            <p className="mt-3 text-base font-medium text-slate-800">{TAKEOVER_NOTICE_TEXT}</p>
            <button
              type="button"
              onClick={closeNotice}
              autoFocus
              className="mt-5 w-full rounded-xl bg-slate-900 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              知道了
            </button>
          </div>
        </div>
      )}
    </section>
    </div>
  );
}

/** 右侧账号卡片：大头像 + QQ 名称 + 退出登录（退出后回到扫码，另一个人可以登录自己的号） */
function AccountCard({ status, onLoggedOut }: { status: ConnectStatusDTO; onLoggedOut: () => Promise<unknown> | void }) {
  const toast = useToast();
  const uin = status.uin!;
  const online = status.state === 'online';
  const [imgFailed, setImgFailed] = useState(false);
  const [confirmContext, setConfirmContext] = useState<{ accountEpoch: string; uin: string } | null>(null);
  const [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    if (confirmContext === null) return;
    setBusy(true);
    try {
      await logoutConnect(confirmContext, erase);
      await onLoggedOut();
      setConfirmContext(null);
      setErase(false);
      toast(erase ? '已退出并删除本号数据' : '已退出登录，请用要登录的 QQ 扫码');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="mb-8 rounded-2xl border border-slate-200 bg-white px-6 py-7 text-center shadow-sm md:mb-0 md:mt-8 md:w-64 md:shrink-0">
      <div className="relative mx-auto h-24 w-24">
        {imgFailed ? (
          <span className="flex h-full w-full items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-slate-400">
            <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
          </span>
        ) : (
          <img
            src={qqAvatarUrl(uin).replace('s=100', 's=640')}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="h-full w-full rounded-full border border-slate-200 bg-slate-100 object-cover"
          />
        )}
        <span
          className={`absolute bottom-1 right-1 h-4 w-4 rounded-full border-2 border-white ${online ? 'bg-emerald-500' : 'bg-slate-300'}`}
          aria-hidden
        />
      </div>
      <div className="mt-4 truncate text-lg font-semibold text-slate-900" title={status.nickname ?? uin}>
        {status.nickname ?? `QQ ${uin}`}
      </div>
      <div className="mt-0.5 text-sm text-slate-400">
        {status.nickname ? `${uin} · ` : ''}
        {online ? '已连接' : '未连接'}
      </div>
      <p className="mt-1 text-xs text-slate-300">头像由 QQ 服务器提供，加载时会带上你的 QQ 号</p>
      <button
        type="button"
        onClick={() => setConfirmContext({ accountEpoch: status.account_epoch, uin })}
        className="mt-6 w-full rounded-xl border border-rose-200 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50"
      >
        退出登录
      </button>

      <ConfirmDialog
        open={confirmContext !== null}
        title="退出当前 QQ？"
        confirmText={erase ? '退出并删除数据' : '退出登录'}
        danger
        busy={busy}
        onConfirm={() => void onLogout()}
        onCancel={() => {
          setConfirmContext(null);
          setErase(false);
        }}
      >
        <p>
          将退出 QQ {confirmContext?.uin ?? uin}。退出后回到扫码页，可以换另一个 QQ 号登录；已整理的群和日程会保留。
        </p>
        <label className="mt-3 flex items-start gap-2 text-left text-sm text-rose-600">
          <input
            type="checkbox"
            checked={erase}
            onChange={(e) => setErase(e.target.checked)}
            className="mt-0.5"
          />
          同时删除这个号在本机的全部数据（群、日程、待办，不可恢复）
        </label>
      </ConfirmDialog>
    </aside>
  );
}

/**
 * 一键下载 NapCat 采集端组件（四问题修复 #3）：点按钮 → POST /api/setup/fetch-napcat
 * → 每秒轮询进度 → 完成后刷新连接状态（后端就绪 error 消失）。
 */
function NapcatDownload({ onInstalled }: { onInstalled: () => Promise<unknown> | void }) {
  const toast = useToast();
  const [progress, setProgress] = useState<SetupProgressDTO | null>(null);
  const [busy, setBusy] = useState(false);

  const active = progress !== null && (progress.status === 'downloading' || progress.status === 'verifying' || progress.status === 'extracting');

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const p = await getFetchNapcatProgress();
        if (cancelled) return;
        setProgress(p);
        if (p.status === 'done') {
          toast('采集端组件下载完成，点「重启采集端」启动');
          void onInstalled();
        } else if (p.status === 'error') {
          toast(p.message || '下载失败，请检查网络后重试', 'error');
        }
      } catch {
        // 单次轮询失败不中断
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, onInstalled, progress?.status, toast]);

  async function onDownload() {
    setBusy(true);
    try {
      await startFetchNapcat();
      const p = await getFetchNapcatProgress();
      setProgress(p);
      toast('已开始下载，完成后自动恢复');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  if (progress?.installed) return null;

  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={() => void onDownload()}
        disabled={busy || active}
        className="rounded-xl bg-slate-900 px-6 py-3 text-base font-medium text-white hover:bg-slate-700 disabled:opacity-60"
      >
        一键下载 NapCat 组件
      </button>
      {active && (
        <div className="mx-auto mt-4 w-full max-w-xs text-left">
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-slate-800 transition-all"
              style={{ width: `${Math.max(progress!.percent, 3)}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">{progress!.message || '下载中…'}</p>
        </div>
      )}
      {progress?.status === 'error' && (
        <p className="mt-2 text-xs text-rose-500">{progress.message || '下载失败，请检查网络后重试'}</p>
      )}
    </div>
  );
}

/** 旧版单库数据迁移提示（升级后出现一次，用户可手动把 legacy 目录改成对应 QQ 号） */
function LegacyDataNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-left text-sm text-amber-800">
      <p className="font-medium">检测到旧版本数据</p>
      <p className="mt-1 leading-relaxed">
        旧版的单一数据库已迁移到 <code className="rounded bg-amber-100 px-1">data/accounts/legacy/</code>。
        因为无法确认它属于哪个 QQ 号，新账号会从空数据开始；如需找回，把该文件夹改名为对应 QQ 号即可。
      </p>
      <button type="button" onClick={onDismiss} className="mt-2 font-medium text-amber-700 underline-offset-2 hover:underline">
        知道了
      </button>
    </div>
  );
}

/** 本机账号数据管理（问题 1 延伸）：列出这台电脑上已有的账号库，可删除指定账号数据 */
function AccountsCard() {
  const toast = useToast();
  const [data, setData] = useState<AccountsDTO | null>(null);
  const [confirmUin, setConfirmUin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listAccounts()
      .then(setData)
      .catch(() => setData(null));
  }, []);

  async function onDelete() {
    if (confirmUin === null) return;
    setBusy(true);
    try {
      await deleteAccountData(confirmUin);
      toast(`已删除账号 ${confirmUin} 的本机数据`);
      setConfirmUin(null);
      setData(await listAccounts());
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  if (!data || data.accounts.length === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-6 text-left shadow-sm">
      <p className="text-sm font-medium text-slate-700">本机账号数据</p>
      <p className="mt-1 text-xs text-slate-400">每个 QQ 号一个独立数据库，换号登录互不可见；删除不会影响其他账号。</p>
      <ul className="mt-3 space-y-2">
        {data.accounts.map((a) => (
          <li key={a.uin} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span>
              <span className="font-mono">{a.uin}</span>
              {a.current && <span className="ml-2 text-xs text-emerald-600">当前登录</span>}
              <span className="ml-2 text-xs text-slate-400">{formatBytes(a.size_bytes)}</span>
            </span>
            {a.current ? (
              <span className="shrink-0 text-xs text-slate-400">请使用上方的退出并删除</span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmUin(a.uin)}
                className="shrink-0 text-xs font-medium text-rose-500 hover:underline"
              >
                删除数据
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={confirmUin !== null}
        title={`删除账号 ${confirmUin ?? ''} 的数据？`}
        confirmText="删除"
        danger
        busy={busy}
        onConfirm={() => void onDelete()}
        onCancel={() => setConfirmUin(null)}
      >
        该账号在这台电脑上的群监听、事件、待办、课表、记忆将全部删除，无法恢复。
      </ConfirmDialog>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 二维码每 2s 换一次 t 重取（过期时后端会换新图）；图还没生成（404）时显示占位 */
function QrCode() {
  const [src, setSrc] = useState(qrcodeUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setSrc(qrcodeUrl()), 2000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <img
          src={src}
          alt="QQ 登录二维码"
          onLoad={() => setFailed(false)}
          onError={() => setFailed(true)}
          className={`h-full w-full object-contain ${failed ? 'hidden' : ''}`}
        />
        {failed && <span className="text-sm text-slate-400">二维码生成中…</span>}
      </div>
      <p className="mt-5 text-lg font-medium text-slate-800">用手机 QQ 扫码登录（仅首次需要）</p>
      <p className="mt-1 text-sm text-slate-400">扫码后在手机上确认登录</p>
    </div>
  );
}

function Spinner({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-4" aria-busy>
      <span className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" />
      <p className="text-lg text-slate-600">{text}</p>
    </div>
  );
}

function Panel({ title, tone, children }: { title: string; tone?: 'error'; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm">
      <p className={`text-lg font-medium leading-relaxed ${tone === 'error' ? 'text-rose-700' : 'text-slate-800'}`}>{title}</p>
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}

function BigButton({ children, onClick, busy }: { children: ReactNode; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-xl bg-slate-900 px-6 py-3 text-base font-medium text-white hover:bg-slate-700 disabled:opacity-60"
    >
      {busy ? '处理中…' : children}
    </button>
  );
}
