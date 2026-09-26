// 待办判定（FR-15）：现算，不存状态。前端有一份同款拷贝（web/src/lib/todo.ts），
// 两边用同一组用例保证一致。
import type { EventDTO } from './types.js';

/**
 * 进待办的三类：
 * ① 开始/结束/截止都没有的事件；
 * ② 作业（assignment）只有开始、没有截止；
 * ③ 上面两条都只看「还活着」的状态（active / pending_confirm）。
 * 群里补了截止 → 自然离开待办；群里取消 / 手动完成 → 自然消失。
 */
export function isTodo(
  e: Pick<EventDTO, 'status' | 'type' | 'start_at' | 'end_at' | 'deadline_at'>,
): boolean {
  if (e.status !== 'active' && e.status !== 'pending_confirm') return false;
  if (e.deadline_at !== null) return false;
  const noTime = e.start_at === null && e.end_at === null;
  return noTime || e.type === 'assignment';
}
