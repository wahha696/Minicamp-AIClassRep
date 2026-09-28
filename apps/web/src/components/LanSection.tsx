// 设置页「手机访问」（局域网只读）：开关 + 手机链接 + 换链接（rotate token）。
// 后端开关改了之后要重启 ClassRep 才真正开始/停止监听局域网（restart_required 提示）。
import { useState } from 'react';
import { getLanSettings, rotateLanToken, setLanEnabled } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useToast } from './Toast';
import { toastError } from '../lib/errors';

export default function LanSection() {
  const { data, error, refresh } = usePolling(getLanSettings, 30_000);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function onToggle() {
    if (!data || busy) return;
    setBusy(true);
    try {
      const next = await setLanEnabled(!data.enabled);
      await refresh();
      toast(
        next.enabled
          ? '已开启，重启 ClassRep 后手机就能访问'
          : '已关闭，重启 ClassRep 后停止手机访问',
      );
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  async function onRotate() {
    if (busy) return;
    setBusy(true);
    try {
      await rotateLanToken();
      await refresh();
      toast('已换新链接，旧链接不能再打开');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="lan" className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800">手机只读访问</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">
            同一 Wi-Fi 下用手机看日程。只读：不能改数据，也看不到二维码和 API Key。开关要重启 ClassRep 才生效。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={data?.enabled ?? false}
          aria-label="手机只读访问"
          disabled={busy || !data}
          onClick={() => void onToggle()}
          className="shrink-0 disabled:opacity-60"
        >
          <span
            className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${
              data?.enabled ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                data?.enabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
      </div>

      {error && !data && <p className="mt-3 text-sm text-rose-600">{error.message}</p>}

      {data?.enabled && (
        <div className="mt-4">
          {data.account_rebind_required && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              旧链接已失效（重启或换号后需重新签发）。点下方「换新链接」生成新链接。
            </p>
          )}
          {data.urls.map((u) => (
            <div key={u} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">{u}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(u)
                    .then(() => toast('链接已复制，发到手机浏览器打开'))
                    .catch(() => toast('复制失败，请手动长按复制', 'error'));
                }}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
              >
                复制链接
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => void onRotate()}
            disabled={busy}
            className="mt-3 text-xs text-slate-400 underline hover:text-slate-600 disabled:opacity-60"
          >
            换新链接（旧链接立即失效）
          </button>
        </div>
      )}

      {data?.restart_required && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          已改动，重启 ClassRep 后才{data.enabled ? '开始' : '停止'}手机访问。
        </p>
      )}
    </section>
  );
}
