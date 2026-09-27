// 全局布局（D1）：顶部栏（Logo + 导航 + 状态灯）+ 连接黄条 + 页面 + 手机底部 Tab。
import { NavLink, Outlet } from 'react-router-dom';
import Avatar from './Avatar';
import ConnectBanner from './ConnectBanner';
import Pet from './Pet';
import StatusLights from './StatusLights';
import SyncButton from './SyncButton';

interface NavItem {
  to: string;
  label: string;
  icon: string; // SVG path（24×24 描边），不为几个图标引入依赖
}

export const NAV: NavItem[] = [
  { to: '/', label: '今日', icon: 'M12 3v2m0 14v2m9-9h-2M5 12H3m15.4-6.4-1.4 1.4M7 17l-1.4 1.4m12.8 0L17 17M7 7 5.6 5.6M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z' },
  { to: '/week', label: '本周', icon: 'M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z' },
  { to: '/groups', label: '群管理', icon: 'M17 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m18 0v-1a4 4 0 0 0-3-3.9M14 4.1a4 4 0 0 1 0 7.8M14 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z' },
  { to: '/connect', label: '连接', icon: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
  { to: '/demo', label: '演示', icon: 'M6 4l14 8-14 8V4Z' },
  { to: '/settings', label: '设置', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <NavLink to="/" className="shrink-0 text-lg font-semibold tracking-tight text-slate-900">
            AI课代表
          </NavLink>
          <nav className="hidden flex-1 gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${
                    isActive ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-900'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SyncButton />
            <StatusLights />
            {/* 手机上跟在状态灯后面；宽屏贴到整个页面的最右上角 */}
            <Avatar className="md:absolute md:right-5 md:top-[10px]" />
          </div>
        </div>
        <ConnectBanner />
      </header>

      {/* 手机上底部有 Tab 栏，留出空间 */}
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-6 md:pb-10">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 py-2 text-[10px] ${isActive ? 'text-slate-900' : 'text-slate-400'}`
            }
          >
            <Icon d={n.icon} />
            {n.label}
          </NavLink>
        ))}
      </nav>

      {/* 桌宠（PET-1~6）：纯装饰浮层，交互与层级说明见 components/Pet.tsx 顶部注释 */}
      <Pet />
    </div>
  );
}
