import { ApiError } from '../api/error';

/** 把接口错误转成给人看的 toast 文案。局域网（手机）写操作被后端 403 → 「请在电脑上操作」（D8） */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return '请在电脑上操作';
  if (e instanceof Error && e.message) return e.message;
  return '操作失败，请重试';
}

export function toastError(toast: (text: string, tone?: 'info' | 'error') => void, e: unknown) {
  toast(errorText(e), 'error');
}
