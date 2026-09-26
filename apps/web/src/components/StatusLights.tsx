// 页头 4 个状态灯（QQ / 数据库 / AI / 快判），每 5s 读 /health（FR-7.4）。
// 悬停（手机上点一下）显示中文说明。
import { getHealth } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { lightsFromHealth, type LightColor } from '../lib/status';

const DOT: Record<LightColor, string> = {
  green: 'bg-green-500',
  red: 'bg-red-500',
  gray: 'bg-slate-300',
};

export default function StatusLights() {
  const { data, error, loading } = usePolling(getHealth, 5000);
  if (loading) return null;
  // 读不到 /health（后端没开）→ 全红；读到过但本次失败也按读不到处理
  const lights = lightsFromHealth(error ? undefined : data);

  return (
    <ul className="flex items-center gap-1 sm:gap-3" aria-label="系统状态">
      {lights.map((l) => (
        <li key={l.key} className="group relative">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
            aria-label={l.tip}
            title={l.tip}
          >
            <span className={`h-2 w-2 rounded-full ${DOT[l.color]}`} />
            <span>{l.label}</span>
            {l.color === 'gray' && <span className="hidden text-slate-400 sm:inline">预留</span>}
          </button>
          <span
            role="tooltip"
            className="pointer-events-none absolute right-0 top-full z-40 mt-1 hidden w-max max-w-60 rounded-md bg-slate-800 px-2.5 py-1.5 text-xs leading-relaxed text-white shadow-lg group-hover:block group-focus-within:block"
          >
            {l.tip}
          </span>
        </li>
      ))}
    </ul>
  );
}
