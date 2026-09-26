import { Navigate, Route, Routes } from 'react-router-dom';
import { ConnectStatusProvider } from './components/ConnectStatus';
import FirstRunGuard from './components/FirstRunGuard';
import Layout from './components/Layout';
import { ToastProvider } from './components/Toast';
import Placeholder from './pages/Placeholder';

export default function App() {
  return (
    <ToastProvider>
      <ConnectStatusProvider>
        <Routes>
          <Route element={<FirstRunGuard />}>
            <Route element={<Layout />}>
              <Route index element={<Placeholder title="今日" task="D2" />} />
              <Route path="week" element={<Placeholder title="本周" task="D3" />} />
              <Route path="groups" element={<Placeholder title="群管理" task="D6" />} />
              <Route path="connect" element={<Placeholder title="连接 QQ" task="D5" />} />
              <Route path="demo" element={<Placeholder title="演示控制台" task="D7" />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </ConnectStatusProvider>
    </ToastProvider>
  );
}
