import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkNodeRuntime, runtimeEnv } from './node-runtime.mjs';
import { pnpmDistCommand } from './pnpm.mjs';
import { preparePythonRuntime } from './python-runtime.mjs';

test('Node minimum checks SQLite properties actually required by the database layer', async () => {
  for (const version of ['20.20.0', '22.13.0', '22.15.0']) assert.equal((await checkNodeRuntime(version)).ok, false);
  assert.equal((await checkNodeRuntime()).ok, true);
});

test('runtime PATH is child-local, preserves system tools and handles Windows Path spelling', () => {
  const source = { Path: 'synthetic-system-tools', OTHER: 'untouched' };
  const env = runtimeEnv(source, ['synthetic-pnpm-bin']);
  assert.equal(env.Path, undefined);
  assert.ok(env.PATH.startsWith(dirname(process.execPath)));
  assert.ok(env.PATH.includes('synthetic-pnpm-bin'));
  assert.ok(env.PATH.endsWith('synthetic-system-tools'));
  assert.deepEqual(source, { Path: 'synthetic-system-tools', OTHER: 'untouched' });
});

test('no global Node/pnpm: direct and nested lifecycle commands work from a spaced portable path', () => {
  const root = mkdtempSync(join(tmpdir(), 'classrep runtime 空格 '));
  try {
    const bin = join(root, 'package', 'bin'); mkdirSync(bin, { recursive: true });
    const cjs = join(bin, 'pnpm.cjs');
    // Model pnpm's real lifecycle boundary: it launches bare node and recursively bare pnpm.
    writeFileSync(cjs, `const {spawnSync}=require('node:child_process');
const nested=process.argv.includes('nested');
const r=nested ? spawnSync('pnpm',['direct'],{shell:true,encoding:'utf8'})
 : spawnSync('node',['-p','process.execPath'],{encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`);
    const stripped = { ...process.env };
    for (const key of Object.keys(stripped)) if (key.toLowerCase() === 'path') delete stripped[key];
    stripped.PATH = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin';
    const command = pnpmDistCommand(cjs, stripped);
    for (const mode of ['direct', 'nested']) {
      const result = spawnSync(command.cmd, [...command.args, mode], { env: command.env, cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), process.execPath);
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Python provisioning failure is explicit, nonfatal, attempted once and cleared by a successful retry', () => {
  const environment = { PATH: 'synthetic' }; const logs = []; let calls = 0;
  assert.equal(preparePythonRuntime('synthetic-root', { environment, log: text => logs.push(text), run: () => { calls++; return { status: 1 }; } }), false);
  assert.equal(calls, 1);
  assert.equal(environment.CLASSREP_PYTHON_SETUP_FAILED, '1');
  assert.ok(logs.some(text => text.includes('仍继续启动网页')));
  assert.ok(logs.some(text => text.includes('不会在后台重复')));
  assert.equal(preparePythonRuntime('synthetic-root', { environment, log: () => {}, run: () => ({ status: 0 }) }), true);
  assert.equal(environment.CLASSREP_PYTHON_SETUP_FAILED, undefined);
});
