// 全局共享的连接状态：每 2s 读一次 /api/connect/status（架构.md §4）。
// 黄条、路由守卫、连接页（D5）、换号重挂载都从这里读，不各自轮询。
import { createContext, useContext, type ReactNode } from 'react';
import { getConnectStatus } from '../api/client';
import type { ConnectStatusDTO } from '../api/types';
import { usePolling, type Polling } from '../hooks/usePolling';
import { setCurrentUin } from '../lib/account';

const ConnectStatusContext = createContext<Polling<ConnectStatusDTO> | null>(null);

export function ConnectStatusProvider({ children }: { children: ReactNode }) {
  const polling = usePolling(getConnectStatus, 2000);
  // 渲染期写入（幂等）：uin 一变，AccountLayout 的 key 立刻让整棵子树用新账号键重挂载
  setCurrentUin(polling.data?.uin);
  return <ConnectStatusContext.Provider value={polling}>{children}</ConnectStatusContext.Provider>;
}

export function useConnectStatus(): Polling<ConnectStatusDTO> {
  const ctx = useContext(ConnectStatusContext);
  if (!ctx) throw new Error('useConnectStatus 必须在 ConnectStatusProvider 里使用');
  return ctx;
}
