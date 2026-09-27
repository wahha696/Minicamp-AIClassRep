// 路由守卫（修复计划 3.2）：first_run === true（没有 uin 或 DeepSeek 未配置）时拦到 /setup 向导。
// 连接状态还没拿到时先照常渲染，不闪白屏；拿到后若需要再跳。
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { SKIP_CONNECT_KEY, readAccountFlag, shouldRedirectToConnect } from '../lib/status';
import { useConnectStatus } from './ConnectStatus';

export default function FirstRunGuard() {
  const { data } = useConnectStatus();
  const { pathname } = useLocation();
  const skip = readAccountFlag(SKIP_CONNECT_KEY) === '1';

  if (shouldRedirectToConnect(data, pathname, skip)) {
    return <Navigate to="/setup" replace />;
  }
  return <Outlet />;
}
