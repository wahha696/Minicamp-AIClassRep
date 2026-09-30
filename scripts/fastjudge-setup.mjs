#!/usr/bin/env node
// 本地快判 Python 环境供给：让「克隆的 / 下载 release 的」开箱即用。
//   Windows：python embeddable（可移植，无绝对路径）→ <root>/py/，
//            解开 ._pth 的 import site + get-pip + 装 requirements.txt
//   POSIX ：python3 -m venv <root>/.venv → pip install -r requirements.txt
// 已被 jev-local.getFastjudgePython 探测：py/python.exe > .venv > 系统 python。
// 用法：node scripts/fastjudge-setup.mjs [--root <fastjudge目录>]
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR);
const log = (...a) => console.log('[fastjudge-setup]', ...a);
const fail = (msg) => { console.error('[fastjudge-setup] ❌', msg); process.exit(1); };

const argRoot = process.argv.indexOf('--root');
const ROOT = argRoot > -1 ? process.argv[argRoot + 1] : join(REPO, 'classrep-fastjudge');
const REQ = join(ROOT, 'requirements.txt');
const PY_VER = process.env.FASTJUDGE_PY_VER ?? '3.12.10'; // 最后一个发布 Windows embed 的 3.12
const PY_MIRROR = (process.env.PYTHON_MIRROR ?? 'https://www.python.org/ftp/python').replace(/\/+$/, '');

if (!existsSync(join(ROOT, 'src', 'infer.py'))) fail(`找不到 ${ROOT}/src/infer.py`);
if (!existsSync(REQ)) fail(`找不到 ${REQ}`);

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${label} 失败（exit ${r.status}）`);
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${url}：HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

function pythonUsable(py) {
  const r = spawnSync(py, ['-c', 'import sklearn,jieba,joblib,numpy;print("ok")'], {
    encoding: 'utf8', timeout: 60_000, cwd: ROOT,
  });
  return r.status === 0 && String(r.stdout).includes('ok');
}

async function provisionWindows() {
  const pyDir = join(ROOT, 'py');
  const pyExe = join(pyDir, 'python.exe');
  if (!existsSync(pyExe)) {
    const zip = join(pyDir, `python-${PY_VER}-embed-amd64.zip`);
    log(`下载 python-${PY_VER}-embed-amd64…`);
    await download(`${PY_MIRROR}/${PY_VER}/python-${PY_VER}-embed-amd64.zip`, zip);
    log('解压…');
    // GNU tar 会把 E:\ 当远程主机；优先用 Windows 自带 bsdtar，没有则 PowerShell
    const winTar = 'C:\\Windows\\System32\\tar.exe';
    if (existsSync(winTar)) {
      run(winTar, ['-xf', zip, '-C', pyDir], '解压 embed 包');
    } else {
      run('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${pyDir.replace(/'/g, "''")}' -Force`],
      '解压 embed 包');
    }
    // embeddable 默认关闭 site：放开才能吃到 Lib/site-packages 里的依赖
    const pth = join(pyDir, `python${PY_VER.split('.').slice(0, 2).join('')}._pth`);
    const txt = readFileSync(pth, 'utf8').replace(/^#?\s*import site\s*$/m, 'import site');
    writeFileSync(pth, txt.includes('Lib\\site-packages') ? txt : `Lib\\site-packages\n${txt}`);
  }
  if (!existsSync(join(pyDir, 'Scripts', 'pip.exe')) && !existsSync(join(pyDir, 'Lib', 'site-packages', 'pip'))) {
    const getPip = join(pyDir, 'get-pip.py');
    await download('https://bootstrap.pypa.io/get-pip.py', getPip);
    run(pyExe, [getPip, '--no-warn-script-location'], 'get-pip');
  }
  // jieba 只有 sdist：embed 环境先装构建后端，再关 build isolation 装依赖
  run(pyExe, ['-m', 'pip', 'install', 'setuptools', 'wheel'], 'pip install setuptools');
  log('安装 requirements.txt（sklearn/jieba/joblib/numpy，约 200MB）…');
  run(pyExe, ['-m', 'pip', 'install', '-r', REQ, '--no-warn-script-location', '--no-build-isolation'], 'pip install');
  return pyExe;
}

function provisionPosix() {
  const pyExe = join(ROOT, '.venv', 'bin', 'python');
  if (!existsSync(pyExe)) run('python3', ['-m', 'venv', join(ROOT, '.venv')], 'python3 -m venv');
  run(pyExe, ['-m', 'pip', 'install', '-r', REQ], 'pip install');
  return pyExe;
}

const pyExe = process.platform === 'win32' ? await provisionWindows() : provisionPosix();
if (!pythonUsable(pyExe)) fail(`装完但 import 校验不过：${pyExe}`);
log(`就绪：${pyExe}`);
