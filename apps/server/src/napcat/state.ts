// 连接状态机（架构.md §4）。主人是 A。
import type { ConnectStatusDTO } from '../types.js';

let since = Date.now();

/** B0 空实现：恒为 error +「未实现」。A 接上真正的状态机。 */
export function getConnectStatus(): ConnectStatusDTO {
  return {
    state: 'error',
    since,
    message: '未实现',
    first_run: false,
  };
}

/** 进入新状态时记时间（A 用） */
export function markStateSince(now: number = Date.now()): void {
  since = now;
}
