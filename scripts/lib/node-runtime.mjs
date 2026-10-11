import { dirname, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Child scripts must use the same Node even when it is a downloaded executable. */
export function runtimeEnv(source = process.env, extraBinDirs = []) {
  const env = { ...source };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const inherited = pathKey ? env[pathKey] : '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [dirname(process.execPath), ...extraBinDirs, inherited].filter(Boolean).join(delimiter);
  return env;
}

export async function checkNodeRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    return { ok: false, error: `Node ${version} 版本过低，需要至少 22.16，推荐 24 LTS` };
  }
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(':memory:');
    if (db.isOpen !== true || typeof db.isTransaction !== 'boolean') throw new Error('缺少 SQLite 事务状态接口');
    return { ok: true };
  } catch {
    return { ok: false, error: `Node ${version} 缺少所需 node:sqlite 接口，请安装 24 LTS` };
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--check')) {
  const result = await checkNodeRuntime();
  if (!result.ok) console.error(result.error);
  process.exitCode = result.ok ? 0 : 1;
}
