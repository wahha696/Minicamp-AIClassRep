// 免安装包更新器：切换前保存事务和独立恢复程序；失败恢复旧版，已提交的更新只清理。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const recoveryOnly = process.argv.includes('--recover-only');
// 恢复副本位于 <root>/data/update/recover.mjs，常规入口位于 <root>/app/update.mjs。
const INSTALL_ROOT = recoveryOnly ? resolve(dirname(SCRIPT), '../..') : dirname(dirname(SCRIPT));
const WORK = join(INSTALL_ROOT, 'data', 'update');
const STAGING = join(WORK, 'staging');
const NEWROOT = join(WORK, 'new');
const OLDROOT = join(WORK, 'old');
const JOURNAL = join(WORK, 'transaction.json');
const pendingPath = join(WORK, 'pending.json');

function safeParts(path) {
  if (typeof path !== 'string') throw new Error('恢复记录路径无效');
  const parts = path.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) {
    throw new Error('恢复记录路径无效');
  }
  if (parts[0].toLowerCase() === 'data' ||
      (parts.length !== 1 && !(parts.length === 2 && parts[0] === 'runtime'))) {
    throw new Error('恢复记录越过更新范围');
  }
  return parts;
}

function location(root, entry) {
  return join(root, ...safeParts(entry.path));
}

function saveJournal(transaction) {
  const temp = `${JOURNAL}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(transaction)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, JOURNAL);
}

function readJournal() {
  const tx = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  if (tx.version !== 1 || !['switching', 'committed'].includes(tx.state) || !Array.isArray(tx.entries)) {
    throw new Error('恢复记录格式无效，保留备份，请手动检查 data/update');
  }
  const paths = new Set();
  for (const entry of tx.entries) {
    safeParts(entry.path);
    const key = entry.path.toLowerCase();
    if (typeof entry.hadOriginal !== 'boolean' || paths.has(key)) throw new Error('恢复记录条目无效');
    paths.add(key);
  }
  return tx;
}

function rollback(tx) {
  const failures = [];
  for (const entry of [...tx.entries].reverse()) {
    const target = location(INSTALL_ROOT, entry);
    const backup = location(OLDROOT, entry);
    const prepared = location(NEWROOT, entry);
    try {
      if (entry.hadOriginal) {
        // 备份存在说明旧文件已移走，新文件尚未放入也必须恢复。
        // 备份不存在则是尚未切换，或上次恢复已完成；重复恢复不删除它。
        if (existsSync(backup)) {
          rmSync(target, { recursive: true, force: true });
          mkdirSync(dirname(target), { recursive: true });
          renameSync(backup, target);
        }
      } else if (!existsSync(prepared)) {
        // 原本不存在的组件只有在预备文件已被移走后，才可能需要撤销。
        rmSync(target, { recursive: true, force: true });
      }
    } catch (e) {
      failures.push(`${entry.path}: ${e.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`回滚尚未完成，备份和恢复记录已保留：${failures.join('；')}`);
  }
}

function cleanup(committed) {
  // committed 持久化后才清 pending；清理中断时继续清理，不回滚成功更新。
  if (committed) rmSync(pendingPath, { force: true });
  for (const dir of [NEWROOT, OLDROOT, STAGING]) rmSync(dir, { recursive: true, force: true });
  rmSync(JOURNAL, { force: true });
}

function recover() {
  const tx = readJournal();
  if (tx.state === 'committed') {
    cleanup(true);
    console.log('[update] 已完成上次成功更新的清理。');
  } else {
    rollback(tx);
    cleanup(false);
    console.log('[update] 已恢复到完整旧版，保留待更新信息，下次启动可重试。');
  }
}

function quarantine(zipPath, reason) {
  console.error(`[update] 更新包校验未通过：${reason}，本次继续使用旧版。`);
  renameSync(pendingPath, `${pendingPath}.failed.json`);
  if (zipPath && existsSync(zipPath)) renameSync(zipPath, `${zipPath}.bad`);
}

/**
 * Release 实际下发 ZIP。Windows 上优先用系统 PowerShell 的 Expand-Archive：
 * Git for Windows 附带的 GNU tar 在含中文/空格的安装路径下会解压失败，且普通用户机器
 * 也不保证 PATH 中有可处理 ZIP 的 tar。环境变量传路径，避免把用户路径拼进命令脚本。
 * PowerShell 被策略禁用时再回退系统 tar；非 Windows 保持 tar 路径。
 */
function extractArchive(zipPath) {
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:CLASSREP_UPDATE_ARCHIVE -DestinationPath $env:CLASSREP_UPDATE_STAGING -Force",
    ], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        CLASSREP_UPDATE_ARCHIVE: zipPath,
        CLASSREP_UPDATE_STAGING: STAGING,
      },
    });
    if (ps.status === 0) return true;
  }
  const tar = spawnSync('tar', ['-x', '-f', zipPath, '-C', STAGING], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return tar.status === 0;
}

function applyUpdate() {
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  const zipPath = pending.zip;
  if (typeof zipPath !== 'string' || !existsSync(zipPath)) throw new Error('更新包不存在，现有安装未改动');
  if (typeof pending.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pending.sha256)) {
    quarantine(zipPath, '缺少 SHA-256 校验信息');
    return false;
  }
  const got = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (got !== pending.sha256.toLowerCase()) {
    quarantine(zipPath, 'SHA-256 校验失败');
    return false;
  }

  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  if (!extractArchive(zipPath)) throw new Error('更新包解压失败，现有安装未改动');
  const src = existsSync(join(STAGING, 'ClassRep')) ? join(STAGING, 'ClassRep') : STAGING;
  if (!existsSync(join(src, 'app', 'server', 'dist', 'index.js'))) {
    throw new Error('更新包缺 app/server/dist/index.js，现有安装未改动');
  }

  rmSync(NEWROOT, { recursive: true, force: true });
  rmSync(OLDROOT, { recursive: true, force: true });
  mkdirSync(NEWROOT, { recursive: true });
  mkdirSync(OLDROOT, { recursive: true });
  const names = readdirSync(src).filter((name) => name.toLowerCase() !== 'data');
  const entries = [];
  for (const name of names) {
    cpSync(join(src, name), join(NEWROOT, name), { recursive: true });
    // runtime 不整体移动；node.exe 和其他运行时文件参与同一事务。
    const paths = name === 'runtime'
      ? readdirSync(join(NEWROOT, name)).filter((file) => file !== 'node.exe.old').map((file) => `runtime/${file}`)
      : [name];
    for (const path of paths) {
      const entry = { path, hadOriginal: existsSync(join(INSTALL_ROOT, ...safeParts(path))) };
      entries.push(entry);
    }
  }

  // app 和 runtime 都可能暂时消失，恢复不能依赖它们。
  cpSync(SCRIPT, join(WORK, 'recover.mjs'));
  cpSync(process.execPath, join(WORK, 'recovery-node.exe'));
  const tx = { version: 1, state: 'switching', entries };
  saveJournal(tx);
  try {
    for (const entry of entries) {
      const target = location(INSTALL_ROOT, entry);
      const backup = location(OLDROOT, entry);
      mkdirSync(dirname(backup), { recursive: true });
      mkdirSync(dirname(target), { recursive: true });
      if (entry.hadOriginal) renameSync(target, backup);
      renameSync(location(NEWROOT, entry), target);
    }
    saveJournal({ ...tx, state: 'committed' });
  } catch (e) {
    console.error(`[update] 切换失败：${e.message}，正在恢复旧版…`);
    // 以磁盘记录为准；提交标记已写入时，只清理已完整安装的新版。
    recover();
    return false;
  }
  try {
    cleanup(true);
  } catch (e) {
    // Windows 上正在运行的旧 Node 已被移到备份，退出后才能删除。
    // committed 记录保留，启动器用独立 Node 接着清理；新版不会被误回滚。
    console.warn(`[update] 新版已完整安装，备份清理待重试：${e.message}`);
  }
  console.log(`[update] 已更新到 v${pending.to ?? '?'}。`);
  return true;
}

try {
  if (existsSync(JOURNAL)) {
    recover();
    // 先恢复，不在同一个进程内再次尝试更新。
  } else if (!recoveryOnly) {
    if (!applyUpdate()) process.exitCode = 1;
  }
} catch (e) {
  console.error(`[update] ${e.message}`);
  process.exitCode = 1;
}
