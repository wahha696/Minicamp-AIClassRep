// 连接页 /connect（D5，架构.md §4、§7）：按连接状态显示扫码 / 接管 QQ / 异常 / 加载。
// 状态来自全局 ConnectStatusProvider（每 2s 轮询），这里不再单独轮询。
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { getLlmSettings, qrcodeUrl, restartConnect, saveLlmSettings } from '../api/client';
import type { LlmSettingsDTO } from '../api/types';
import { useConnectStatus } from '../components/ConnectStatus';
import { useToast } from '../components/Toast';
import { toastError } from '../lib/errors';
import {
  ERROR_FALLBACK,
  QQ_DOWNLOAD_URL,
  SKIP_CONNECT_KEY,
  TAKEOVER_NOTICE_KEY,
  TAKEOVER_NOTICE_TEXT,
} from '../lib/status';

export default function Connect() {
  const { data, error, refresh } = useConnectStatus();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);

  const state = data?.state;

  // online：不再自动跳走（这页还有「AI 接入」要配）；这台电脑第一次看到 online 时弹一次接管提示
  useEffect(() => {
    if (state === 'online' && localStorage.getItem(TAKEOVER_NOTICE_KEY) !== '1') setNotice(true);
  }, [state]);

  function closeNotice() {
    localStorage.setItem(TAKEOVER_NOTICE_KEY, '1');
    setNotice(false);
  }

  async function onRestart() {
    setBusy(true);
    try {
      await restartConnect();
      await refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  function goDemo() {
    localStorage.setItem(SKIP_CONNECT_KEY, '1');
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
            <BigButton onClick={onRestart} busy={busy}>
              关闭电脑版 QQ 并继续
            </BigButton>
            <p className="mt-3 text-xs text-slate-400">关闭前请确认电脑版 QQ 里没有正在发送的消息</p>
          </Panel>
        );
        break;
      case 'error':
        body = (
          <Panel title={data.message || ERROR_FALLBACK} tone="error">
            <div className="flex flex-wrap justify-center gap-3">
              <BigButton onClick={onRestart} busy={busy}>
                重启采集端
              </BigButton>
              <a
                href={QQ_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-slate-300 px-6 py-3 text-base font-medium text-slate-700 hover:bg-slate-50"
              >
                下载最新版 QQ
              </a>
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

  return (
    <section className="mx-auto max-w-md space-y-8 py-6 text-center">
      <div>
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
        <AiSettings />
      </div>

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
  );
}

/** AI 接入：目前只有 DeepSeek。key 存在本机 data/llm.json，页面上只显示打码后的提示 */
function AiSettings() {
  const toast = useToast();
  const [info, setInfo] = useState<LlmSettingsDTO | null>(null);
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getLlmSettings()
      .then((s) => {
        setInfo(s);
        setEditing(!s.configured);
      })
      .catch(() => setEditing(true));
  }, []);

  async function onSave(ev: FormEvent) {
    ev.preventDefault();
    if (!key.trim()) {
      toast('请先填写 API Key', 'error');
      return;
    }
    setSaving(true);
    try {
      const s = await saveLlmSettings('deepseek', key.trim());
      setInfo(s);
      setKey('');
      setEditing(false);
      toast('AI 已接入，新消息会自动整理成日程');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-6 text-left shadow-sm">
      <label className="block text-sm font-medium text-slate-700" htmlFor="ai-provider">
        服务商
      </label>
      <select
        id="ai-provider"
        value="deepseek"
        disabled
        className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
      >
        <option value="deepseek">DeepSeek</option>
      </select>

      {info?.configured && !editing ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm">
          <span className="text-emerald-700">
            已接入 · <span className="font-mono">{info.key_hint}</span>
            {info.source === 'env' && <span className="ml-1 text-emerald-600/70">（来自 .env）</span>}
          </span>
          <button type="button" onClick={() => setEditing(true)} className="shrink-0 font-medium text-slate-600 hover:underline">
            更换
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void onSave(e)} className="mt-4">
          <label className="block text-sm font-medium text-slate-700" htmlFor="ai-key">
            API Key
          </label>
          <input
            id="ai-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-500"
          />
          <p className="mt-1.5 text-xs text-slate-400">
            在{' '}
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" className="underline">
              DeepSeek 开放平台
            </a>{' '}
            创建。只保存在这台电脑上。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            {info?.configured && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setKey('');
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
            )}
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
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
      <p className="mt-1 text-sm text-slate-400">扫码后会自动跳转</p>
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
