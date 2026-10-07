import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const windowsOnly = { skip: process.platform !== 'win32' };

function write(base, relative, content) {
  const target = join(base, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'classrep-rescue-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.split(sep).at(-1).startsWith('classrep-rescue-test-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const install = join(root, '旧版 安装目录');
  const payload = join(root, 'payload', 'ClassRep');
  write(install, '启动.bat', '@echo old');
  write(install, 'app/server/dist/index.js', 'old-app');
  write(install, 'app/version.json', JSON.stringify({ version: '1.0.0' }));
  write(install, 'runtime/node.exe', 'old-node');
  write(install, 'napcat/old.txt', 'old-napcat');
  write(install, 'data/accounts/10001/classrep.db', 'student-private-data');
  write(install, 'data/llm.json', 'encrypted-key');
  write(install, 'data/update/pending.json', '{}');

  write(payload, '启动.bat', '@echo new');
  write(payload, 'app/server/dist/index.js', 'new-app');
  write(payload, 'app/version.json', JSON.stringify({ version: '1.0.1' }));
  write(payload, 'runtime/node.exe', 'new-node');
  write(payload, 'napcat/new.txt', 'new-napcat');
  write(payload, 'data/should-not-copy.txt', 'package-data');

  const zip = join(root, 'ClassRep.zip');
  const archive = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:PAYLOAD -DestinationPath $env:ZIP -Force",
  ], { encoding: 'utf8', env: { ...process.env, PAYLOAD: payload, ZIP: zip } });
  assert.equal(archive.status, 0, archive.stderr || archive.stdout);
  const zipBytes = readFileSync(zip);
  const manifest = join(root, 'ClassRep.manifest.json');
  writeFileSync(manifest, JSON.stringify({
    version: '1.0.1', zip: 'ClassRep.zip', size: zipBytes.length,
    sha256: createHash('sha256').update(zipBytes).digest('hex'),
  }));
  const run = (manifestFile = manifest) => spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, '修复升级.ps1'),
    '-InstallDirectory', install, '-PackagePath', zip, '-ManifestPath', manifestFile, '-NonInteractive',
  ], { encoding: 'utf8', timeout: 30_000 });
  return { root, install, zip, manifest, run };
}

test('旧版救援：真实 ZIP 在中文空格路径升级，data 原样保留并生成独立备份', windowsOnly, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(join(f.install, 'app/server/dist/index.js'), 'utf8'), 'new-app');
  assert.equal(readFileSync(join(f.install, 'runtime/node.exe'), 'utf8'), 'new-node');
  assert.equal(readFileSync(join(f.install, 'data/accounts/10001/classrep.db'), 'utf8'), 'student-private-data');
  assert.equal(readFileSync(join(f.install, 'data/llm.json'), 'utf8'), 'encrypted-key');
  assert.equal(existsSync(join(f.install, 'data/should-not-copy.txt')), false);
  assert.equal(existsSync(join(f.install, 'data/update')), false);
  const backups = readdirSync(f.root).filter((name) => name.startsWith('ClassRep-data-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(f.root, backups[0], 'accounts/10001/classrep.db'), 'utf8'),
    'student-private-data',
  );
});

test('旧版救援：清单校验失败时程序与 data 均不改动', windowsOnly, (t) => {
  const f = fixture(t);
  const bad = join(f.root, 'bad.manifest.json');
  writeFileSync(bad, JSON.stringify({ version: '1.0.1', size: readFileSync(f.zip).length, sha256: '0'.repeat(64) }));
  const result = f.run(bad);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(f.install, 'app/server/dist/index.js'), 'utf8'), 'old-app');
  assert.equal(readFileSync(join(f.install, 'data/accounts/10001/classrep.db'), 'utf8'), 'student-private-data');
  assert.equal(readdirSync(f.root).some((name) => name.startsWith('ClassRep-data-backup-')), false);
});

test('旧版救援：上次在移走程序后中断，重跑先恢复完整旧版', windowsOnly, (t) => {
  const f = fixture(t);
  const work = join(f.install, 'data/rescue-upgrade');
  mkdirSync(join(work, 'old'), { recursive: true });
  mkdirSync(join(work, 'new'), { recursive: true });
  renameSync(join(f.install, 'app'), join(work, 'old/app'));
  write(f.install, 'app/server/dist/index.js', 'interrupted-new-app');
  writeFileSync(join(work, 'transaction.json'), JSON.stringify({
    version: 1, state: 'switching', entries: [{ name: 'app', had_original: true }],
  }));
  const bad = join(f.root, 'bad-after-interrupt.manifest.json');
  writeFileSync(bad, JSON.stringify({ version: '1.0.1', size: readFileSync(f.zip).length, sha256: '0'.repeat(64) }));
  const result = f.run(bad);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(f.install, 'app/server/dist/index.js'), 'utf8'), 'old-app');
  assert.equal(existsSync(work), false);
  assert.equal(readFileSync(join(f.install, 'data/accounts/10001/classrep.db'), 'utf8'), 'student-private-data');
});
