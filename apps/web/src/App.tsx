import { Navigate, Route, Routes } from 'react-router-dom';
import { ConnectStatusProvider } from './components/ConnectStatus';
import FirstRunGuard from './components/FirstRunGuard';
import Layout from './components/Layout';
import { ToastProvider } from './components/Toast';
import Connect from './pages/Connect';
import Groups from './pages/Groups';
import Demo from './pages/Demo';
import Settings from './pages/Settings';
import Timetable from './pages/Timetable';
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
              <Route path="timetable" element={<Timetable />} />
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
