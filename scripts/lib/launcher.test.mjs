import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Windows launcher starts without command errors from a legacy console code page',
  { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-launcher-'));
    try {
      const install = join(root, 'fresh 中文');
      mkdirSync(join(install, 'runtime'), { recursive: true });
      mkdirSync(join(install, 'app/server/dist'), { recursive: true });
      copyFileSync(process.execPath, join(install, 'runtime/node.exe'));
      writeFileSync(join(install, 'app/server/dist/index.js'), 'process.stdout.write("LAUNCHER_OK\\n");');
      const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      writeFileSync(join(install, 'start.cmd'), readFileSync(join(repo, '启动.bat'), 'utf8').replace(/\r?\n/g, '\r\n'));
      // ASCII wrapper establishes the same default code page as an ordinary
      // Chinese Windows console before parsing the actual product launcher.
      writeFileSync(join(install, 'check.cmd'), '@echo off\r\nchcp 936 >nul\r\ncall start.cmd\r\n');
      const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'check.cmd'], {
        cwd: install, encoding: 'utf8', windowsHide: true, timeout: 20_000,
        env: { ...process.env, NODE_OPTIONS: '', CLASSREP_OPEN_BROWSER: '0' },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), 'LAUNCHER_OK');
      assert.equal(result.stderr.trim(), '');
    } finally {
      assert.equal(dirname(realpathSync(root)), realpathSync(resolve(tmpdir())));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
