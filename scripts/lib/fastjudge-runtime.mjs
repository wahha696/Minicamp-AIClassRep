import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Only probes the owned interpreter; no user Python/PATH modules are loaded. */
export function pythonCommandUsable(executable, args) {
  try {
    return spawnSync(executable, args, { stdio: 'ignore', windowsHide: true, timeout: 60_000 }).status === 0;
  } catch { return false; }
}

function repairPathFile(directory, versionTag) {
  // This is our embedded interpreter's path file, not a user/site configuration.
  // Rebuilding its small allowlist also repairs a missing or interrupted write.
  const file = join(directory, `python${versionTag}._pth`);
  const expected = `python${versionTag}.zip\n.\nLib\\site-packages\nimport site\n`;
  if (!existsSync(file) || readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== expected) writeFileSync(file, expected);
}

function defaultExtract(archive, directory) {
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (existsSync(tar)) {
    const result = spawnSync(tar, ['-xf', archive, '-C', directory], { stdio: 'inherit', windowsHide: true });
    if (result.status === 0) return;
  }
  const quoted = value => "'" + value.replace(/'/g, "''") + "'";
  const result = spawnSync('powershell', ['-NoProfile', '-Command',
    `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(directory)} -Force`],
  { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('便携 Python 解压失败；修复网络或磁盘问题后可重新运行准备脚本');
}

/** Repair only files supplied by the official embedded archive. Never remove the
 * runtime directory, site-packages, model directory or any user data. A failed
 * extraction remains retryable even if python.exe was written before failure. */
export async function ensureWindowsEmbeddedPython({ root, version, mirror, download,
  extract = defaultExtract, probe = pythonCommandUsable, log = () => {} }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('便携 Python 版本格式不正确');
  const directory = join(resolve(root), 'py');
  const tag = version.split('.').slice(0, 2).join('');
  const executable = join(directory, 'python.exe');
  const core = ['python.exe', `python${tag}.dll`, `python${tag}.zip`];
  mkdirSync(directory, { recursive: true });
  const usable = () => {
    if (!core.every(name => existsSync(join(directory, name)))) return false;
    repairPathFile(directory, tag);
    return probe(executable, ['-I', '-X', 'utf8', '-c',
      `import encodings,json,sqlite3,ctypes,zipfile,sys;assert sys.version_info[:2]==(${version.split('.')[0]},${version.split('.')[1]})`]);
  };
  if (usable()) return executable;

  const archive = join(directory, `python-${version}-embed-amd64.repair.zip`);
  log('便携 Python 核心缺失或损坏，正在补齐运行时（保留模型与数据）…');
  try {
    await download(`${mirror.replace(/\/+$/, '')}/${version}/python-${version}-embed-amd64.zip`, archive);
    extract(archive, directory);
    if (!usable()) throw new Error('便携 Python 核心校验失败；请检查解压及系统运行环境，再运行准备脚本重试');
  } finally {
    // Only this helper's exact temporary download is removed, never a directory.
    rmSync(archive, { force: true });
  }
  return executable;
}
