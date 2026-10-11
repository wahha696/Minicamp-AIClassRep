// This preference contains only a local path. Never store read permissions or keys.
const prefix = 'classrep.wechat.data-root.v2:';

function storageKey(installationId: string | undefined, account: string | undefined): string | null {
  // /health supplies this installation identity. Never infer it from a path or
  // migrate the old account-only key: another clone may share this origin.
  return installationId && account ? prefix + encodeURIComponent(installationId) + ':' + encodeURIComponent(account) : null;
}

export function validWechatDataRoot(value: string): boolean {
  return value.length <= 4096 && /^[A-Za-z]:[\\/]/.test(value)
    && !/[\x00-\x1f<>:"|?*]/.test(value.slice(2))
    && /[\\/]xwechat_files[\\/]*$/i.test(value);
}

export function loadWechatDataRoot(installationId: string | undefined, account?: string): string {
  const key = storageKey(installationId, account);
  if (!key) return '';
  try {
    const value = localStorage.getItem(key);
    return value && validWechatDataRoot(value) ? value : '';
  } catch { return ''; }
}

export function saveWechatDataRoot(installationId: string | undefined, account: string | undefined, value: string): void {
  const key = storageKey(installationId, account);
  if (!key) return;
  const path = value.trim();
  try {
    if (!path) localStorage.removeItem(key);
    else if (validWechatDataRoot(path)) localStorage.setItem(key, path);
  } catch { /* Browser storage may be unavailable; manual input still works. */ }
}
