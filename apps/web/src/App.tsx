import { Navigate, Route, Routes } from 'react-router-dom';
import { ConnectStatusProvider, useConnectStatus } from './components/ConnectStatus';
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
  return <Layout key={data?.uin ?? 'none'} />;
}

export default function App() {
  return (
    <ToastProvider>
      <ConnectStatusProvider>
        <Routes>
          <Route element={<FirstRunGuard />}>
            {/* 向导页不带侧栏（还没登录，没有日程可看） */}
            <Route path="setup" element={<Setup />} />
            <Route element={<AccountLayout />}>
              <Route index element={<Today />} />
              <Route path="week" element={<Week />} />
              {/* 课表已并入设置页，旧链接 / 书签跳过去 */}
              <Route path="timetable" element={<Navigate to="/settings" replace />} />
              <Route path="groups" element={<Groups />} />
              <Route path="connect" element={<Connect />} />
              <Route path="demo" element={<Demo />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </ConnectStatusProvider>
    </ToastProvider>
  );
}
