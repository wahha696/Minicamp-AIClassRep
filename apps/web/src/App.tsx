import { Navigate, Route, Routes } from 'react-router-dom';
import { ConnectStatusProvider } from './components/ConnectStatus';
import FirstRunGuard from './components/FirstRunGuard';
import Layout from './components/Layout';
import { ToastProvider } from './components/Toast';
import Connect from './pages/Connect';
import Groups from './pages/Groups';
import Demo from './pages/Demo';
import Settings from './pages/Settings';
import Today from './pages/Today';
import Week from './pages/Week';

export default function App() {
  return (
    <ToastProvider>
      <ConnectStatusProvider>
        <Routes>
          <Route element={<FirstRunGuard />}>
            <Route element={<Layout />}>
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
