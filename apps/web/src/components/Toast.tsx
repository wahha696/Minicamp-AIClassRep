// 极简 toast：页面里 `const toast = useToast(); toast('已注入 3 条消息')`。
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'error';
interface Item {
  id: number;
  text: string;
  tone: Tone;
}

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const nextId = useRef(1);

  const show = useCallback((text: string, tone: Tone = 'info') => {
    const id = nextId.current++;
    setItems((list) => [...list.filter((x) => x.text !== text), { id, text, tone }]);
    setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), 3000);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* 手机上底部有 Tab 栏，往上让出 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-8">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`rounded-lg px-4 py-2 text-sm text-white shadow-lg ${
              t.tone === 'error' ? 'bg-rose-600' : 'bg-slate-800'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
