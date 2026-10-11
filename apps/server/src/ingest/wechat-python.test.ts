import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { wechatCapability, wechatIdentityRuntime, wechatPythonArgs, wechatPythonEnv } from './wechat-python.js';

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), '课代表 portable ')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('owned WeChat Python startup (no WeChat access)', () => {
  it('reports missing components and unsupported platforms without executing any file', () => {
    const root = temp();
    expect(wechatCapability(root, 'linux')).toEqual({ available: false, reason: 'platform_unsupported' });
    expect(wechatCapability(root, 'win32')).toEqual({ available: false, reason: 'runtime_missing' });
    const py = join(root, 'classrep-fastjudge', 'py'); const tool = join(root, 'tools', 'wechat4-read-probe');
    mkdirSync(py, { recursive: true }); mkdirSync(tool, { recursive: true });
    writeFileSync(join(py, 'python.exe'), 'not executed');
    writeFileSync(join(tool, 'identity_worker.py'), 'not executed');
    expect(wechatCapability(root, 'win32').available).toBe(false);
    writeFileSync(join(tool, 'message_worker.py'), 'not executed');
    const oldDemo = process.env.DEMO_MODE;
    try {
      process.env.DEMO_MODE = 'true';
      expect(wechatCapability(root, 'win32')).toEqual({ available: true });
    } finally {
      if (oldDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = oldDemo;
    }
  });
  it('does not forward AI secrets, Python injection hooks or path to the child', () => {
    expect(wechatPythonEnv({ SystemRoot: 'C:\\Windows', TEMP: 'local', LLM_API_KEY: 'secret',
      PYTHONPATH: 'injected', PYTHONSTARTUP: 'injected', PATH: 'injected' })).toEqual({
      SystemRoot: 'C:\\Windows', TEMP: 'local', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    });
  });

  it('requires absolute owned paths and complete shipped files without starting a worker', () => {
    expect(() => wechatPythonArgs('relative.py')).toThrow('WECHAT_RUNTIME_PATH_INVALID');
    const root = temp();
    expect(() => wechatIdentityRuntime(root)).toThrow('WECHAT_RUNTIME_MISSING');
    const py = join(root, 'classrep-fastjudge', 'py'); const tool = join(root, 'tools', 'wechat4-read-probe');
    mkdirSync(py, { recursive: true }); mkdirSync(tool, { recursive: true });
    writeFileSync(join(py, 'python.exe'), 'not executed'); writeFileSync(join(tool, 'identity_worker.py'), 'not executed');
    expect(wechatIdentityRuntime(root)).toEqual({ executable: join(py, 'python.exe'), entry: join(tool, 'identity_worker.py') });
  });

  it.skipIf(!process.env.WECHAT4_TEST_PYTHON)('isolated real Python imports a sibling in Chinese/spaced paths, preserves literal arguments and writes no cache', () => {
    const root = temp(); const entry = join(root, 'entry.py');
    writeFileSync(join(root, 'sibling.py'), 'VALUE = "synthetic"\n');
    writeFileSync(entry, 'import sibling,sys,json\nprint(json.dumps([sibling.VALUE,sys.argv[1:]],ensure_ascii=False))\n');
    const values = ['文字 空格 😀', 'literal;$(never-execute)', '--anything'];
    const result = spawnSync(process.env.WECHAT4_TEST_PYTHON!, wechatPythonArgs(entry, values), {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, env: wechatPythonEnv(),
    });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(['synthetic', values]);
    expect(existsSync(join(root, '__pycache__'))).toBe(false);
  });
});
