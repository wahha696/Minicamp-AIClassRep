// 全局连接黄条（D1）：reconnecting / kicked / error / 未连接。online 时不显示。
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { restartConnect } from '../api/client';
import { bannerFor } from '../lib/status';
import { useConnectStatus } from './ConnectStatus';
import { useToast } from './Toast';
import { toastError } from '../lib/errors';

export default function ConnectBanner() {
  const { data, refresh } = useConnectStatus();
  const { pathname } = useLocation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const banner = bannerFor(data, pathname);
  if (!banner) return null;

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

  return (
    <div role="alert" className="border-b border-amber-200 bg-amber-50 text-amber-900">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <span className="flex-1">{banner.text}</span>
        {'action' in banner && (
          <button
            type="button"
            onClick={onRestart}
            disabled={busy}
            className="rounded-md bg-amber-500 px-3 py-1 font-medium text-white hover:bg-amber-600 disabled:opacity-60"
          >
            {busy ? '处理中…' : banner.actionText}
          </button>
        )}
        {'linkTo' in banner && (
          <Link to={banner.linkTo} className="font-medium text-amber-700 underline underline-offset-2">
            {banner.linkText}
          </Link>
        )}
      </div>
    </div>
  );
}
