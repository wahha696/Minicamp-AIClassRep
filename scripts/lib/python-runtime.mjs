import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runtimeEnv } from './node-runtime.mjs';

/** Provision once per launcher run; failure disables Python features, not the app. */
export function preparePythonRuntime(root, { run = spawnSync, environment = process.env, log = console.log } = {}) {
  log('[ClassRep] 检查微信与本地快判共享 Python 运行时…');
  const prepared = run(process.execPath, [join(root, 'scripts', 'fastjudge-setup.mjs')], {
    cwd: root, stdio: 'inherit', windowsHide: true, env: runtimeEnv(environment),
  });
  if (prepared.status !== 0) {
    environment.CLASSREP_PYTHON_SETUP_FAILED = '1';
    log('[ClassRep] Python 下载或依赖准备失败：本次微信与本地快判不可用，仍继续启动网页，可查看数据和使用 QQ。');
    log('[ClassRep] 请检查上方网络/安装错误，运行 node scripts/fastjudge-setup.mjs 后重新启动；不会在后台重复下载安装。');
    return false;
  }
  delete environment.CLASSREP_PYTHON_SETUP_FAILED;
  return true;
}
