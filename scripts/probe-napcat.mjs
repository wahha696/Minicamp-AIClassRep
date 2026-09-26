#!/usr/bin/env node
/**
 * A1 一次性探测脚本（不进产品）——按 架构.md §10 / NapCat接口规格.md §8 实测 6 项：
 *   1) node 直接 spawn NapCatWinBootMain.exe 注入成功；taskkill /T /F 清干净进程树
 *   2) disableWebUI:true 且无 -q 时，二维码写出 cache/qrcode.png，扫码后 3001 开启
 *   3) -q <uin> 免扫码快速登录
 *   4) 被挤下线时 bot_offline 是否在 WS 断开前送达（需你在另一台电脑登同一 QQ）
 *   5) napcat/ 在含中文/空格路径下运行（用 --napcat-dir 指向中文路径副本）
 *   6) 子进程 stdout 能否经管道读取（写入 data/logs/*.log 并统计字节数）
 *
 * 用法：
 *   node scripts/probe-napcat.mjs                    # 第一轮：无 -q，扫码登录
 *   node scripts/probe-napcat.mjs --uin <QQ号>       # 第二轮：-q 快速登录（验证第 3 项）
 *   node scripts/probe-napcat.mjs --uin <QQ号> --napcat-dir "<中文 路径>\napcat"   # 验证第 5 项
 *
 * 停止方式（任一）：本窗口按回车；或创建停止标记文件 <root>/data/probe-stop；或 Ctrl+C。
 * 停止时自动 taskkill /T /F 结束 NapCat + QQ 进程树，并报告是否清干净。
 */

import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync,
  createWriteStream,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------- 参数 ----------
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const uin = argOf('--uin');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const napcatDir = argOf('--napcat-dir') ? join(argOf('--napcat-dir')) : join(root, 'napcat');
const stopFile = join(root, 'data', 'probe-stop');
const maxMinutes = Number(argOf('--max-minutes') || 15);

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---------- 结果收集 ----------
const R = {
  napcatDir, uin: uin || null,
  qqExe: null, spawnOk: false, spawnFail: null,
  qrAppeared: false, qrPath: null, qrRefreshes: 0,
  wsConnected: false, wsConnectDelayMs: null, wsCloseAfterKilled: null,
  lifecycleSelfId: null, groupListOk: false, groupList: null,
  botOffline: null,            // { at, tag, message, wsStillOpen }
  stdoutBytes: 0, stderrBytes: 0, stdoutError: null,
  killed: false, residual: null, childExit: null,
  msgEvents: 0, selfMsgEvents: 0,
};

// ---------- 1. 定位 QQ.exe ----------
function findQQExe() {
  try {
    const out = spawnSync('reg', [
      'query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      '/v', 'UninstallString',
    ], { encoding: 'utf8' });
    const m = (out.stdout || '').match(/UninstallString\s+REG_SZ\s+(.*)/);
    if (m) {
      const dir = dirname(m[1].trim().replace(/^"|"$/g, ''));
      const p = join(dir, 'QQ.exe');
      if (existsSync(p)) return p;
    }
  } catch { /* fallthrough */ }
  const fallback = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
  return existsSync(fallback) ? fallback : null;
}
R.qqExe = findQQExe();
if (!R.qqExe) { log('❌ 找不到 QQ.exe（注册表 + 默认路径都没有）。'); process.exit(1); }
log('QQ.exe =', R.qqExe);

// ---------- 2. 预检：活的 QQ / NapCat 不能已在运行 ----------
// 本机实测：tasklist 对提权进程返回 Access denied 且看不到进程；Get-Process 不受影响，优先用它。
function tasklistHas(image) {
  const base = image.replace(/\.exe$/i, '');
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `if (Get-Process -Name '${base}' -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`],
      { encoding: 'utf8' });
    if (/YES/.test(ps.stdout || '')) return true;
    if (/NO/.test(ps.stdout || '')) return false;
  } catch { /* fallthrough */ }
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8' });
  return (out.stdout || '').includes(image);
}

// 真正「活着」的 QQ：线程数 > 0。线程数为 0 的是僵尸进程对象（不运行代码、不占单实例锁，只会出现在列表里）。
function liveQQIds() {
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `if (Get-Process -Name QQ -ErrorAction SilentlyContinue) {
         Get-Process -Name QQ | Where-Object { $_.Threads.Count -gt 0 } | ForEach-Object { $_.Id }
       }`], { encoding: 'utf8' });
    return (ps.stdout || '').split(/\s+/).filter((s) => /^\d+$/.test(s));
  } catch { return []; }
}
const zombies = [];
try {
  const all = spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-Process -Name QQ -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }'],
    { encoding: 'utf8' });
  const allIds = (all.stdout || '').split(/\s+/).filter((s) => /^\d+$/.test(s));
  const live = liveQQIds();
  for (const id of allIds) if (!live.includes(id)) zombies.push(id);
} catch { /* ignore */ }
if (zombies.length) {
  log(`⚠️ 发现僵尸 QQ 进程对象（0 线程，不运行代码，不影响本次探测）：${zombies.join(', ')}（重启电脑后消失）`);
}
if (liveQQIds().length > 0) {
  log('❌ 检测到活的 QQ.exe 正在运行。请先关闭电脑版 QQ（NapCat 注入的是同一进程），再运行本脚本。');
  process.exit(1);
}
if (tasklistHas('NapCatWinBootMain.exe')) {
  log('❌ 检测到 NapCatWinBootMain.exe 残留，请先结束它（或重启电脑）。');
  process.exit(1);
}

// ---------- 3. 写配置（与将来 config.ts 相同的三类文件） ----------
function writeNapcatConfig() {
  const cfgDir = join(napcatDir, 'config');
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(join(root, 'data', 'logs'), { recursive: true });

  const onebot = {
    network: {
      httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
      websocketServers: [{
        name: 'classrep', enable: true, host: '127.0.0.1', port: 3001,
        messagePostFormat: 'array', reportSelfMessage: true, token: '',
        enableForcePushEvent: true, debug: false, heartInterval: 30000,
      }],
    },
    musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
  };
  const files = ['onebot11.json',
    ...readdirSync(cfgDir).filter((f) => /^onebot11_.+\.json$/.test(f))];
  for (const f of files) writeFileSync(join(cfgDir, f), JSON.stringify(onebot, null, 2), 'utf8');

  let webui = {};
  try { webui = JSON.parse(readFileSync(join(cfgDir, 'webui.json'), 'utf8')); } catch { /* 没有就用 {} */ }
  webui.disableWebUI = true;
  writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify(webui, null, 2), 'utf8');

  const entry = pathToFileURL(join(napcatDir, 'napcat.mjs')).href;
  writeFileSync(join(napcatDir, 'loadNapCat.js'), `(async () => {await import("${entry}")})()`, 'utf8');
  log('✅ 已写配置：', files.join(', '), '| webui.json(disableWebUI) | loadNapCat.js');
}
writeNapcatConfig();

// ---------- 4. 删除旧二维码 ----------
const qrFile = join(napcatDir, 'cache', 'qrcode.png');
try { rmSync(join(napcatDir, 'cache', 'qrcode.png'), { force: true }); } catch { /* ignore */ }

// ---------- 5. spawn ----------
const child = spawn(
  join(napcatDir, 'NapCatWinBootMain.exe'),
  [R.qqExe, join(napcatDir, 'NapCatWinBootHook.dll'), ...(uin ? ['-q', uin] : [])],
  {
    cwd: napcatDir,
    windowsHide: true,
    env: {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: join(napcatDir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: join(napcatDir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: join(napcatDir, 'NapCatWinBootHook.dll'),
      NAPCAT_LAUNCHER_PATH: join(napcatDir, 'NapCatWinBootMain.exe'),
      NAPCAT_MAIN_PATH: join(napcatDir, 'napcat.mjs').replaceAll('\\', '/'),
    },
  },
);
const spawnAt = Date.now();
R.spawnOk = true;
log(`🚀 spawn NapCatWinBootMain.exe pid=${child.pid} ${uin ? `-q ${uin}` : '(无 -q，应出二维码)'}`);

// stdout/stderr 全部走管道（§10-6：验证能否拿到）
const logPath = join(root, 'data', 'logs', `probe-napcat-${Date.now()}.log`);
const logStream = createWriteStream(logPath, { flags: 'a' });
child.stdout.on('data', (d) => { R.stdoutBytes += d.length; logStream.write(d); });
child.stderr.on('data', (d) => { R.stderrBytes += d.length; logStream.write('[err] ' + d); });
child.stdout.on('error', (e) => { R.stdoutError = e.code || String(e); });
child.on('exit', (code) => {
  R.childExit = { code, at: Date.now() - spawnAt, byUs: !!R.killed };
  if (!R.killed) log(`⚠️ 子进程在未主动 kill 的情况下退出 code=${code}（运行 ${Math.round((Date.now() - spawnAt) / 1000)}s）`);
});

// ---------- 6. 二维码监视 ----------
let lastQrMtime = 0;
const qrTimer = setInterval(() => {
  try {
    if (!existsSync(qrFile)) return;
    const st = statSync(qrFile);
    if (!R.qrAppeared) {
      R.qrAppeared = true; R.qrPath = qrFile; R.qrDelayMs = Date.now() - spawnAt;
      lastQrMtime = st.mtimeMs;
      log(`🖼️  二维码已生成：${qrFile} （spawn 后 ${((Date.now() - spawnAt) / 1000).toFixed(1)}s）— 请打开它用手机 QQ 扫码`);
    } else if (st.mtimeMs !== lastQrMtime) {
      lastQrMtime = st.mtimeMs; R.qrRefreshes++;
      log('🔄 二维码已刷新（旧的过期了），请重新扫');
    }
  } catch { /* ignore */ }
}, 1000);

// ---------- 7. WS 连接（1s 一次，直到连上） ----------
let ws = null;
const pending = new Map();
let wsEverConnected = false;

function callAction(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('WS 未连接'));
    const echo = 'probe-' + randomUUID();
    const t = setTimeout(() => { pending.delete(echo); reject(new Error(`action ${action} 超时`)); }, timeoutMs);
    pending.set(echo, { resolve, reject, t });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

function handleWS(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return; }
  if (obj.echo && pending.has(obj.echo)) {
    const p = pending.get(obj.echo);
    clearTimeout(p.t); pending.delete(obj.echo);
    if (obj.status === 'ok' || obj.status === 'async') p.resolve(obj.data);
    else p.reject(new Error(`action 失败: ${obj.status} ${obj.message ?? ''}`));
    return;
  }
  if (obj.post_type === 'meta_event' && obj.meta_event_type === 'lifecycle') {
    R.lifecycleSelfId = obj.self_id;
    log(`✅ lifecycle：self_id=${obj.self_id}（WS 连上后 ${(Date.now() - spawnAt) / 1000}s，登录成功）`);
    if (uin && String(obj.self_id) !== String(uin)) {
      log(`⚠️ -q 指定的 ${uin} 与实际登录 ${obj.self_id} 不一致！`);
    }
    return;
  }
  if (obj.post_type === 'notice' && obj.notice_type === 'bot_offline') {
    R.botOffline = {
      at: Date.now(), tag: obj.tag, message: obj.message,
      wsStillOpen: !!ws && ws.readyState === 1,
    };
    log(`🚨 收到 bot_offline！tag=${obj.tag} message=${obj.message} 此刻 WS ${R.botOffline.wsStillOpen ? '仍连接' : '已断开'}`);
    log('（观察：NapCat 可能 3.5s 后自己重启重登——脚本不杀进程，继续观察 WS 变化）');
    return;
  }
  if ((obj.post_type === 'message' || obj.post_type === 'message_sent') && obj.message_type === 'group') {
    if (obj.post_type === 'message_sent') R.selfMsgEvents++; else R.msgEvents++;
  }
}

function connectWS() {
  if (R.killed) return;
  try {
    ws = new WebSocket('ws://127.0.0.1:3001');
    ws.addEventListener('open', () => {
      if (!R.wsEverConnected) {
        R.wsEverConnected = true; R.wsConnected = true;
        R.wsConnectDelayMs = Date.now() - spawnAt;
        log(`🔌 WS 3001 已连上（spawn 后 ${(R.wsConnectDelayMs / 1000).toFixed(1)}s）`);
        setTimeout(async () => {
          try {
            const groups = await callAction('get_group_list', {});
            R.groupListOk = true;
            R.groupList = groups.map((g) => ({ group_id: String(g.group_id), group_name: g.group_name }));
            log(`✅ get_group_list 成功，共 ${groups.length} 个群：`);
            for (const g of R.groupList.slice(0, 30)) log(`   ${g.group_id}  ${g.group_name}`);
            if (R.groupList.length > 30) log(`   …（其余 ${R.groupList.length - 30} 个省略）`);
          } catch (e) { log('❌ get_group_list 失败：', e.message); }
        }, 800);
      }
    });
    ws.addEventListener('message', (ev) => { try { handleWS(String(ev.data)); } catch { /* 不让异常断连 */ } });
    ws.addEventListener('close', () => {
      if (R.botOffline && !R.killed) {
        log(`ℹ️ bot_offline 之后 WS 断开（间隔 ${((Date.now() - R.botOffline.at) / 1000).toFixed(1)}s）——NapCat 可能在自动重登`);
      }
    });
    ws.addEventListener('error', () => { /* close 会跟着来 */ });
  } catch { /* 连不上就下一轮再试 */ }
}
const wsTimer = setInterval(() => {
  if (R.killed) return;
  if (!ws || ws.readyState === 3 || ws.readyState === 2) connectWS();
}, 1000);

// ---------- 8. 停止逻辑 ----------
async function stopAll(reason) {
  if (R.killed) return;
  R.killed = true;
  clearInterval(qrTimer); clearInterval(wsTimer); clearInterval(stopWatcher);
  log(`\n🛑 停止：${reason}`);
  if (R.botOffline && ws && ws.readyState === 1) {
    // 主动 kill 前记录 WS 状态
    R.botOffline.wsStillOpen = true;
  }
  try {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
    R.killed = true;
  } catch (e) { log('taskkill 失败：', e.message); }
  await sleep(1500);
  const liveQQ = liveQQIds();
  const napAlive = tasklistHas('NapCatWinBootMain.exe');
  // 僵尸对象（0 线程）不算「残留进程」，但如实报告——A7 验收要求任务管理器里无 QQ.exe
  const anyQQ = tasklistHas('QQ.exe');
  R.residual = { liveQQ: liveQQ.length > 0, zombieQQ: anyQQ && liveQQ.length === 0, napcat: napAlive };
  const qqMsg = liveQQ.length > 0 ? `仍在运行（pid ${liveQQ.join(',')}）❌`
    : anyQQ ? '僵尸进程对象残留（0 线程，不运行代码；任务管理器仍可见，重启电脑后消失）⚠️'
    : '无 ✅';
  log(`🧹 taskkill /T /F 后残留检查：QQ.exe ${qqMsg}；NapCatWinBootMain.exe ${napAlive ? '仍在运行 ❌' : '无 ✅'}`);
  if (ws) { try { R.wsCloseAfterKilled = ws.readyState; ws.close(); } catch { /* ignore */ } }
  printSummary();
  process.exit(0);
}

const stopWatcher = setInterval(() => {
  try { if (existsSync(stopFile)) { rmSync(stopFile, { force: true }); stopAll('检测到停止标记文件'); } } catch { /* ignore */ }
}, 500);
process.on('SIGINT', () => { stopAll('Ctrl+C'); });
process.on('SIGHUP', () => { try { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]); } catch { /* best effort */ } process.exit(0); });
setTimeout(() => stopAll(`达到最长运行时间 ${maxMinutes} 分钟`), maxMinutes * 60_000);

// 交互式回车停止（后台/无 TTY 时依赖停止标记文件）
try {
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (/\r|\n/.test(d)) stopAll('你按了回车'); });
    log('（停止方式：在本窗口按回车，或 Ctrl+C）');
  } else {
    log(`（非交互模式：创建文件即可停止 → ${stopFile}）`);
  }
} catch { /* ignore */ }

function printSummary() {
  const sec = (ms) => ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
  log('\n========== PROBE 结论摘要（回填 需求文档.md §8 用） ==========');
  log(`napcat 目录        : ${napcatDir}${/[\u4e00-\u9fff]/.test(napcatDir) ? '（含中文）' : ''}${/ /.test(napcatDir) ? '（含空格）' : ''}`);
  log(`QQ.exe             : ${R.qqExe}`);
  log(`-q 参数            : ${uin ?? '（无）'}`);
  log(`1) node spawn 注入 : ${R.spawnOk && (!R.childExit || R.childExit.byUs) ? '成功 ✅' : R.childExit ? `进程提前退出 code=${R.childExit.code} ❌` : '运行中'}`);
  log(`   taskkill 清树   : ${R.residual ? ((R.residual.liveQQ || R.residual.napcat) ? '有活进程残留 ❌' : R.residual.zombieQQ ? '无活进程，但有僵尸对象 ⚠️' : '干净 ✅') : '—'}`);
  log(`2) 无 -q 出二维码  : ${R.qrAppeared ? `是（${sec(R.qrDelayMs ?? null)}，刷新 ${R.qrRefreshes} 次）→ ${R.wsConnected ? '扫码后 3001 开启 ✅' : 'WS 未连上'}` : uin ? '未出现（-q 快速登录时正常）' : '未出现 ❌'}`);
  log(`   WS 3001 连接    : ${R.wsConnected ? `成功（spawn 后 ${sec(R.wsConnectDelayMs)}）✅` : '未连上 ❌'}`);
  log(`   lifecycle       : ${R.lifecycleSelfId ? `self_id=${R.lifecycleSelfId} ✅` : '未收到 ❌'}`);
  log(`   get_group_list  : ${R.groupListOk ? `成功（${R.groupList?.length} 个群）✅` : '未成功 ❌'}`);
  log(`3) -q 快速登录     : ${uin ? (R.qrAppeared ? '回落到二维码 ❌（该账号无本机登录记录或快速登录失败）' : R.wsConnected ? '免扫码直接登录 ✅' : '未连上') : '本轮未测'}`);
  log(`4) bot_offline     : ${R.botOffline ? `已送达（WS ${R.botOffline.wsStillOpen ? '断开前送达 ✅' : '断开后才到 ❌'}，tag=${R.botOffline.tag}）` : '未触发（需另一台电脑登同一账号）'}`);
  log(`5) 路径兼容        : 见上方 napcat 目录标注（空格=${/ /.test(napcatDir)}，中文=${/[\u4e00-\u9fff]/.test(napcatDir)}）`);
  log(`6) stdout 管道     : ${R.stdoutError ? `不可读（${R.stdoutError}）❌` : `可读 ✅（out ${R.stdoutBytes}B / err ${R.stderrBytes}B → ${logPath}）`}`);
  log(`群消息事件计数     : 收到 ${R.msgEvents} 条（自己发的 message_sent ${R.selfMsgEvents} 条）`);
  log('==============================================================');
}
log('探测运行中…等待二维码 / WS 连接。');
