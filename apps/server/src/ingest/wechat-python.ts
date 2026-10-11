import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { WechatCapability } from '../../../../shared/workspaces.js';

// Embedded Python does not put the script directory on sys.path. Set only our
// owned entry directory; -I ignores PYTHONPATH, user site and the working folder.
const ENTRY = 'import os,runpy,sys;sys.argv=sys.argv[1:];sys.path.insert(0,os.path.dirname(sys.argv[0]));runpy.run_path(sys.argv[0],run_name="__main__")';

export function wechatPythonArgs(entry: string, args: readonly string[] = []): string[] {
  if (!isAbsolute(entry)) throw new Error('WECHAT_RUNTIME_PATH_INVALID');
  // -I ignores PYTHONUTF8/PYTHONIOENCODING. Set encoding explicitly so group
  // names and non-ASCII pipe requests do not depend on Windows' code page.
  return ['-I', '-X', 'utf8', '-B', '-u', '-c', ENTRY, entry, ...args];
}

/** Do not pass API keys, PYTHONPATH, or Python startup hooks to the read worker. */
export function wechatPythonEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp']);
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) out[key] = value;
  }
  out.PYTHONUTF8 = '1';
  out.PYTHONIOENCODING = 'utf-8';
  return out;
}

/** Locate shipped files only. No install, process discovery or implicit read consent. */
export function wechatIdentityRuntime(root: string): { executable: string; entry: string } {
  if (!isAbsolute(root)) throw new Error('WECHAT_RUNTIME_PATH_INVALID');
  const executable = join(root, 'classrep-fastjudge', 'py', 'python.exe');
  const entry = join(root, 'tools', 'wechat4-read-probe', 'identity_worker.py');
  try {
    if (!statSync(executable).isFile() || !statSync(entry).isFile()) throw new Error();
  } catch { throw new Error('WECHAT_RUNTIME_MISSING'); }
  return { executable, entry };
}

/** File metadata only. Enabling demo controls does not disable real connections. */
export function wechatCapability(root: string, platform: NodeJS.Platform = process.platform): WechatCapability {
  if (platform !== 'win32') return { available: false, reason: 'platform_unsupported' };
  try {
    wechatIdentityRuntime(root);
    if (!statSync(join(root, 'tools', 'wechat4-read-probe', 'message_worker.py')).isFile()) throw new Error();
    return { available: true };
  } catch { return { available: false, reason: 'runtime_missing' }; }
}
