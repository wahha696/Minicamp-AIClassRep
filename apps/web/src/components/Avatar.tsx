// 右上角头像：登录者的 QQ 头像（圆形），点击去连接页。
// 头像图来自 QQ 公开头像服务（只用 QQ 号，不需要登录）；没有 QQ 号或图片加载失败时显示灰色人像。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnectStatus } from './ConnectStatus';

/** QQ 号 → 头像地址（s=100 为 100×100） */
export function qqAvatarUrl(uin: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`;
}

export default function Avatar({ className = '' }: { className?: string }) {
  const { data } = useConnectStatus();
  const uin = data?.uin;
  const online = data?.state === 'online';
  const [failedUin, setFailedUin] = useState<string | null>(null);
  const showImg = uin && failedUin !== uin;

  const title = uin ? `${data?.nickname ? data.nickname + ' · ' : ''}QQ ${uin}${online ? ' · 已连接' : ' · 未连接'}` : '未登录 QQ，点击去连接';

  return (
    <Link
      to="/connect"
      title={title}
      aria-label={title}
      className={`relative block h-9 w-9 shrink-0 rounded-full ring-2 ring-white transition hover:ring-slate-200 ${className}`}
    >
      {showImg ? (
        <img
          src={qqAvatarUrl(uin)}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedUin(uin)}
          className="h-full w-full rounded-full border border-slate-200 bg-slate-100 object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-slate-400">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </span>
      )}
      {/* 右下角小圆点：绿色 = QQ 已连接 */}
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${online ? 'bg-emerald-500' : 'bg-slate-300'}`}
        aria-hidden
      />
    </Link>
  );
}
