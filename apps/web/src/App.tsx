import { Navigate, Route, Routes } from 'react-router-dom';
import { ConnectStatusProvider, useAccess, useConnectStatus } from './components/ConnectStatus';
import type { ReactNode } from 'react';
import FirstRunGuard from './components/FirstRunGuard';
import Layout from './components/Layout';
import { ToastProvider } from './components/Toast';
import Connect from './pages/Connect';
import Groups from './pages/Groups';
import Demo from './pages/Demo';
import Settings from './pages/Settings';
import Setup from './pages/Setup';
import Today from './pages/Today';
import Week from './pages/Week';

/** 换号时整棵页面树重挂载（修复计划第一节 §4）：usePolling、周历缓存、Pet 状态全部重置 */
function AccountLayout() {
  const { data } = useConnectStatus();
  const scope = data?.workspace
    ? `${data.workspace.current?.space_id ?? 'none'}:${data.account_epoch}`
    : data?.uin ?? 'none';
  return <Layout key={scope} />;
}

function LocalPage({ children, demo = false }: { children: ReactNode; demo?: boolean }) {
  const { readonly, demoAvailable } = useAccess();
  if (readonly) return <p role="status">此页面用于管理，请在电脑上操作。手机可查看今日、周历和事项详情。</p>;
  if (demo && !demoAvailable) return <p role="status">当前未启用演示模式，请从连接页开始使用。</p>;
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <ConnectStatusProvider>
        <Routes>
          <Route element={<FirstRunGuard />}>
            {/* 向导页不带侧栏（还没登录，没有日程可看） */}
            <Route path="setup" element={<LocalPage><Setup /></LocalPage>} />
            <Route element={<AccountLayout />}>
              <Route index element={<Today />} />
              <Route path="week" element={<Week />} />
              {/* 课表已并入设置页，旧链接 / 书签跳过去 */}
              <Route path="timetable" element={<Navigate to="/settings" replace />} />
              <Route path="groups" element={<LocalPage><Groups /></LocalPage>} />
              <Route path="connect" element={<LocalPage><Connect /></LocalPage>} />
              <Route path="demo" element={<LocalPage demo><Demo /></LocalPage>} />
              <Route path="settings" element={<LocalPage><Settings /></LocalPage>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </ConnectStatusProvider>
    </ToastProvider>
  );
}
