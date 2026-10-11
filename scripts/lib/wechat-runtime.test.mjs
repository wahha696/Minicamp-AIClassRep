import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { copyWechatIdentityRuntime, WECHAT_IDENTITY_FILES } from './wechat-runtime.mjs';

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('packaging copies only explicit runtime sources, not research/chat/key files', () => {
  const temp = mkdtempSync(join(tmpdir(), '课代表 pack '));
  try {
    const source = join(temp, 'repo', 'tools', 'wechat4-read-probe'); mkdirSync(source, { recursive: true });
    for (const name of WECHAT_IDENTITY_FILES) writeFileSync(join(source, name), 'synthetic source');
    for (const name of ['key.json', 'contact.db', 'private.py', 'test_identity_snapshot.py']) writeFileSync(join(source, name), 'never ship');
    const out = copyWechatIdentityRuntime(join(temp, 'repo'), join(temp, 'out'));
    assert.deepEqual(readdirSync(out).sort(), [...WECHAT_IDENTITY_FILES].sort());
    for (const name of WECHAT_IDENTITY_FILES) assert.equal(readFileSync(join(out, name), 'utf8'), 'synthetic source');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('missing source fails before creating an incomplete runtime', () => {
  const temp = mkdtempSync(join(tmpdir(), 'classrep-pack-missing-'));
  try {
    mkdirSync(join(temp, 'repo', 'tools', 'wechat4-read-probe'), { recursive: true });
    assert.throws(() => copyWechatIdentityRuntime(join(temp, 'repo'), join(temp, 'out')));
    assert.equal(existsSync(join(temp, 'out')), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('shipped runtime imports without repository or test modules (help only, no process access)',
  { skip: !process.env.WECHAT4_TEST_PYTHON }, () => {
    const temp = mkdtempSync(join(tmpdir(), '课代表发布包 '));
    try {
      const out = copyWechatIdentityRuntime(repo, temp);
      for (const worker of ['identity_worker.py', 'catalog_worker.py', 'message_worker.py']) {
      const entry = join(out, worker);
      const result = spawnSync(process.env.WECHAT4_TEST_PYTHON, ['-I', '-B', '-c',
        'import os,runpy,sys;sys.argv=sys.argv[1:];sys.path.insert(0,os.path.dirname(sys.argv[0]));runpy.run_path(sys.argv[0],run_name="__main__")',
        entry, '--help'], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, worker === 'identity_worker.py' ? /--discover/
        : worker === 'message_worker.py' ? /--approve-selected-storage/ : /--approve-contact-read/);
      assert.equal(existsSync(join(out, '__pycache__')), false);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
