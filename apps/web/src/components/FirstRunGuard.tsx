// 路由守卫（D1）：first_run === true 时任何页面都跳到 /connect。
// 连接状态还没拿到时先照常渲染，不闪白屏；拿到后若需要再跳。
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { SKIP_CONNECT_KEY, shouldRedirectToConnect } from '../lib/status';
import { useConnectStatus } from './ConnectStatus';

export default function FirstRunGuard() {
  const { data } = useConnectStatus();
  const { pathname } = useLocation();
  const skip = localStorage.getItem(SKIP_CONNECT_KEY) === '1';

  if (shouldRedirectToConnect(data, pathname, skip)) {
    return <Navigate to="/connect" replace />;
  }
  return <Outlet />;
}
