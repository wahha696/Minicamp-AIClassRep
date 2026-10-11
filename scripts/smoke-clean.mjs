import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fork } from 'node:child_process';
const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
if (process.argv.includes('--child')) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (resource, options) => {
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('Nonlocal network disabled in clean smoke'));
    return originalFetch(resource, options);
  };
  await import('../apps/server/dist/index.js');
  process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
  process.send?.('ready');
} else {
  for (const name of ['.env', '.env.local', 'app/.env']) {
    if (existsSync(join(root, name))) throw new Error('Use a fresh checkout without personal configuration');
  }
  if (existsSync(join(root, 'data')) && readdirSync(join(root, 'data')).some(name => name !== 'mock')) throw new Error('Use a fresh checkout without runtime data');
  if (!existsSync(join(root, 'apps/server/dist/index.js')) || !existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Run pnpm build first');
  // Own this endpoint: it cannot be a real QQ/OneBot collector.
  const sockets = new Set();
  const sink = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const launchId = randomUUID();
  const child = fork(script, ['--child'], { cwd: root, execArgv: [], windowsHide: true, env: {
    ...process.env, NODE_OPTIONS: '', ONEBOT_WS_URL: `ws://127.0.0.1:${sink.address().port}`,
    LLM_API_KEY: '', TYPESAFE_API_KEY: '', ENABLE_JEV: 'false', FASTJUDGE_MODE: 'jev',
    CLASSREP_OPEN_BROWSER: '0', CLASSREP_LAUNCH_ID: launchId,
  } });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const timeout = setTimeout(() => { console.error('Clean smoke timed out'); child.kill(); }, 30000);
  try {
    await Promise.race([
      new Promise(resolve => child.on('message', message => { if (message === 'ready') resolve(); })),
      exit.then(() => { throw new Error('Backend exited before readiness'); }),
    ]);
    let found;
    for (let port = 8000; port <= 8010; port++) {
      try {
        const url = `http://127.0.0.1:${port}`;
        const health = await (await fetch(url + '/health', { signal: AbortSignal.timeout(1000) })).json();
        if (health.launch_id === launchId) { found = { url, health }; break; }
      } catch { /* Never accept another installation. */ }
    }
    if (!found || found.health.db !== 'ok' || found.health.llm_called_count !== 0 || found.health.wechat === 'collecting') throw new Error('Clean health validation failed');
    const page = await fetch(found.url);
    if (!page.ok || !(await page.text()).includes('<div id="root">')) throw new Error('Frontend unavailable');
    child.send('stop');
    const stopped = await exit;
    if (stopped.code !== 0) throw new Error('Backend did not exit cleanly');
    console.log(JSON.stringify({ clean_smoke: 'passed', db: 'ok', ai_calls: 0, wechat_collecting: false, shutdown: 'clean' }));
  } catch (error) {
    console.error(error); child.kill(); await exit; process.exitCode = 1;
  } finally {
    clearTimeout(timeout); sink.close(); for (const socket of sockets) socket.destroy();
  }
}
