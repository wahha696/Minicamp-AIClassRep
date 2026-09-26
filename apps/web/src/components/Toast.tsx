// 极简 toast：页面里 `const toast = useToast(); toast('已注入 3 条消息')`。
// 同时最多显示 2 条：新消息出现在底部，超出时最早的一条向上飘走并淡出；每条 3s 后同样飘走。
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'error';
interface Item {
  id: number;
  text: string;
  tone: Tone;
  leaving: boolean; // 正在飘走（动画结束后移除）
}

const MAX_VISIBLE = 2;
const DURATION = 3000;
const LEAVE_MS = 300; // 与 index.css 的 toast-leave 动画时长一致

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const listRef = useRef<Item[]>([]); // 当前列表的同步副本，先算好再 setItems
  const nextId = useRef(1);

  const update = useCallback((fn: (list: Item[]) => Item[]) => {
    listRef.current = fn(listRef.current);
    setItems(listRef.current);
  }, []);

  /** 标记为飘走，动画结束后真正移除 */
  const dismiss = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      update((list) => list.map((x) => (ids.includes(x.id) ? { ...x, leaving: true } : x)));
      setTimeout(() => update((list) => list.filter((x) => !ids.includes(x.id))), LEAVE_MS);
    },
    [update],
  );

  const show = useCallback(
    (text: string, tone: Tone = 'info') => {
      const id = nextId.current++;
      // 同样的文案不叠两条：旧的直接换成新的
      update((list) => [...list.filter((x) => x.leaving || x.text !== text), { id, text, tone, leaving: false }]);
      const alive = listRef.current.filter((x) => !x.leaving);
      dismiss(alive.slice(0, Math.max(0, alive.length - MAX_VISIBLE)).map((x) => x.id));
      setTimeout(() => dismiss([id]), DURATION);
    },
    [update, dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* 手机上底部有 Tab 栏，往上让出 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center px-4 md:bottom-8">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={
              t.leaving
                ? 'animate-[toast-leave_.3s_ease-in_forwards] overflow-hidden'
                : 'animate-[toast-enter_.2s_ease-out] pt-2'
            }
          >
            <div
              className={`rounded-lg px-4 py-2 text-sm text-white shadow-lg ${
                t.tone === 'error' ? 'bg-rose-600' : 'bg-slate-800'
              }`}
            >
              {t.text}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
