// 二次确认弹窗（D6 删除群数据、D7 清空演示数据共用）。
import { useEffect, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  children?: ReactNode;      // 说明文字
  confirmText: string;
  cancelText?: string;       // 默认「取消」
  footer?: ReactNode;        // 按钮上方的附加内容（如「下次不再提醒」）
  danger?: boolean;          // 危险操作：确认按钮红色
  focusCancel?: boolean;     // 默认焦点放「取消」（清空课表这类不可逆操作防误触）
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ open, title, children, confirmText, cancelText = '取消', footer, danger, focusCancel, busy, onConfirm, onCancel }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 animate-[fade-in_.2s_ease-out] bg-slate-900/40" onClick={() => !busy && onCancel()} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {children && <div className="mt-2 text-sm leading-relaxed text-slate-600">{children}</div>}
        {footer && <div className="mt-4">{footer}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            autoFocus={focusCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            autoFocus={!focusCancel}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
