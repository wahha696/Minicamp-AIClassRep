import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { qrcodeUrl, returnFromDesktopQQ, startDesktopQQ } from '../api/client';
import { toastError } from '../lib/errors';
import { useConnectStatus } from './ConnectStatus';
import { useToast } from './Toast';

export default function ReturnQQ() {
  const { data: connection, refresh } = useConnectStatus();
  const toast = useToast();
  const [busy, setBusy] = useState<'opening' | 'resuming' | null>(null);
  const [qrTick, setQrTick] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const awayRef = useRef(false);
  const desktop = connection?.desktop_qq;
  const phase = busy ?? desktop?.state ?? 'idle';
  const active = phase !== 'idle';
  const local = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(window.location.hostname);
  const transitioning = phase === 'opening' || phase === 'resuming';
  const needsQR = connection?.state === 'waiting_qr' && phase !== 'qq';

  useEffect(() => {
    if (!desktop) return;
    if (desktop.state !== 'idle') awayRef.current = true;
    else if (awayRef.current) {
      awayRef.current = false;
      toast('已返回 ClassRep，正在补读间断期间的群消息');
      window.dispatchEvent(new Event('classrep:resumed'));
    }
  }, [desktop, toast]);

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    buttonRef.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); return; }
      if (event.key === 'Tab') { event.preventDefault(); buttonRef.current?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, [active, transitioning]);

  useEffect(() => {
    if (!needsQR) return;
    const timer = setInterval(() => setQrTick((tick) => tick + 1), 2000);
    return () => clearInterval(timer);
  }, [needsQR]);

  async function start() {
    if (!connection?.uin) return;
    const context = { accountEpoch: connection.account_epoch, uin: connection.uin };
    setBusy('opening');
    try { await startDesktopQQ(context); await refresh(); }
    catch (error) { toastError(toast, error); }
    finally { setBusy(null); }
  }
  async function resume() {
    if (!connection?.uin || !desktop?.session_id) return;
    const context = { accountEpoch: connection.account_epoch, uin: connection.uin };
    setBusy('resuming');
    try { await returnFromDesktopQQ(context, desktop.session_id); await refresh(); }
    catch (error) { toastError(toast, error); }
    finally { setBusy(null); }
  }

  if (!desktop?.supported) return null;
  const title = phase === 'qq' ? '已返回QQ' : phase === 'opening' ? '正在返回QQ…' : phase === 'error' ? '切换未完成' : '正在返回ClassRep…';
  return (
    <>
      {local && <button
        type="button" onClick={() => void start()}
        disabled={active || connection?.state !== 'online' || !connection.uin}
        title={connection?.state !== 'online' ? '请先登录 QQ' : '暂停 ClassRep，打开电脑版 QQ'}
        className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
      >返回QQ</button>}
      {active && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm"
          role="alertdialog" aria-modal="true" aria-labelledby="return-qq-title" aria-describedby="return-qq-description">
          <div className="w-full max-w-sm animate-[fade-in_.2s_ease-out] rounded-2xl border border-slate-100 bg-white p-7 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-700" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 7h4v10h-4M12 12H3m4-4-4 4 4 4" />
              </svg>
            </div>
            <h2 id="return-qq-title" className="text-xl font-semibold tracking-tight text-slate-900">{title}</h2>
            <p id="return-qq-description" className="mt-3 text-sm leading-6 text-slate-500">
              {phase === 'qq'
                ? 'ClassRep 已暂停。关闭 QQ 窗口或点击下方按钮即可返回，期间的群消息会自动补读。'
                : phase === 'opening' ? '正在打开当前账号的电脑版 QQ，请稍候。'
                  : phase === 'error' ? desktop.message : '正在恢复 QQ 连接，随后自动补读间断期间的群消息。'}
            </p>
            {needsQR && <div className="mt-4">
              <img key={qrTick} src={qrcodeUrl()} alt="手机 QQ 扫码恢复登录" className="mx-auto h-40 w-40 rounded-lg" />
              <p className="mt-2 text-xs text-slate-500">QQ 需要重新验证，请用手机 QQ 扫码</p>
            </div>}
            <button ref={buttonRef} type="button" onClick={() => void resume()}
              disabled={transitioning || !local}
              className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-wait disabled:opacity-50">
              返回ClassRep
            </button>
            {!local && <p className="mt-3 text-xs text-slate-500">请在电脑上返回 ClassRep</p>}
          </div>
        </div>, document.body,
      )}
    </>
  );
}
