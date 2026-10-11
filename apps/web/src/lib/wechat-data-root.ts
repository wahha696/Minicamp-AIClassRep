// This preference contains only a local path. Never store read permissions or keys.
const prefix = 'classrep.wechat.data-root.v1:';

export function validWechatDataRoot(value: string): boolean {
  return value.length <= 4096 && /^[A-Za-z]:[\\/]/.test(value)
    && !/[\x00-\x1f<>:"|?*]/.test(value.slice(2))
    && /[\\/]xwechat_files[\\/]*$/i.test(value);
}

export function loadWechatDataRoot(account?: string): string {
  if (!account) return '';
  try {
    const value = localStorage.getItem(prefix + encodeURIComponent(account));
    return value && validWechatDataRoot(value) ? value : '';
  } catch { return ''; }
}

export function saveWechatDataRoot(account: string | undefined, value: string): void {
  if (!account) return;
  const path = value.trim();
  try {
    const key = prefix + encodeURIComponent(account);
    if (!path) localStorage.removeItem(key);
    else if (validWechatDataRoot(path)) localStorage.setItem(key, path);
  } catch { /* Browser storage may be unavailable; manual input still works. */ }
}
