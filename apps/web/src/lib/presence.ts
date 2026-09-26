// 「关掉网页就自动退出」的前端一半：每 20s 向后端报到一次，关页面时说再见。
// 后端只在后台模式（AUTO_EXIT=1）下有这两个接口，普通模式下 404，这里忽略所有错误。
const PING_MS = 20_000;

function newId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export function startPresence(): void {
  const id = newId();
  const ping = () => {
    fetch(`/api/presence?id=${id}`).catch(() => {});
  };
  ping();
  setInterval(ping, PING_MS);
  // 切回这个标签页时立刻报到一次（后台标签页的定时器会被浏览器放慢）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping();
  });
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon?.(`/api/presence/bye?id=${id}`);
  });
}
