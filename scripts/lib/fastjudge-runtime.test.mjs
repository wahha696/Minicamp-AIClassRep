import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ensureWindowsEmbeddedPython, pythonCommandUsable } from './fastjudge-runtime.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'classrep-python-repair-synthetic-'));
  const directory = join(root, 'py'); mkdirSync(directory);
  mkdirSync(join(root, 'models')); mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'models', 'keep.txt'), 'synthetic model marker');
  writeFileSync(join(root, 'data', 'keep.txt'), 'synthetic data marker');
  mkdirSync(join(directory, 'Lib', 'site-packages'), { recursive: true });
  writeFileSync(join(directory, 'Lib', 'site-packages', 'keep.txt'), 'synthetic package marker');
  let downloads = 0;
  const core = ['python.exe', 'python312.dll', 'python312.zip'];
  const populate = () => { for (const name of core) writeFileSync(join(directory, name), 'synthetic valid core'); };
  const options = {
    root, version: '3.12.10', mirror: 'https://synthetic.invalid/python',
    download: async (url, path) => { downloads++; assert.equal(url, 'https://synthetic.invalid/python/3.12.10/python-3.12.10-embed-amd64.zip'); writeFileSync(path, 'synthetic archive'); },
    extract: () => { populate(); },
    probe: (path, args) => {
      assert.equal(path, join(directory, 'python.exe')); assert.equal(args[0], '-I');
      return core.every(name => existsSync(join(directory, name)) && readFileSync(join(directory, name), 'utf8') === 'synthetic valid core')
        && readFileSync(join(directory, 'python312._pth'), 'utf8').includes('Lib\\site-packages\nimport site\n');
    },
  };
  return { root, directory, options, populate, downloads: () => downloads,
    close() {
      try {
        assert.equal(readFileSync(join(root, 'models', 'keep.txt'), 'utf8'), 'synthetic model marker');
        assert.equal(readFileSync(join(root, 'data', 'keep.txt'), 'utf8'), 'synthetic data marker');
        assert.equal(readFileSync(join(directory, 'Lib', 'site-packages', 'keep.txt'), 'utf8'), 'synthetic package marker');
      } finally {
        const rel = relative(realpathSync(tmpdir()), realpathSync(root));
        if (isAbsolute(rel) || !rel.startsWith('classrep-python-repair-synthetic-') || rel.includes('..')) throw Error('SYNTHETIC_CLEANUP_PATH');
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('repairs a partial embed with an existing executable but missing standard library', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, 'python.exe'), 'synthetic partial extraction');
    assert.equal(await ensureWindowsEmbeddedPython(f.options), join(f.directory, 'python.exe'));
    assert.equal(f.downloads(), 1);
    assert.equal(existsSync(join(f.directory, 'python-3.12.10-embed-amd64.repair.zip')), false);
    await ensureWindowsEmbeddedPython(f.options);
    assert.equal(f.downloads(), 1, 'healthy retry must not download again');
  } finally { f.close(); }
});

test('repairs missing or truncated path configuration without downloading healthy core files', async () => {
  const f = fixture();
  try {
    f.populate();
    await ensureWindowsEmbeddedPython(f.options);
    writeFileSync(join(f.directory, 'python312._pth'), 'python312.zip\n#imp');
    await ensureWindowsEmbeddedPython(f.options);
    assert.equal(readFileSync(join(f.directory, 'python312._pth'), 'utf8'), 'python312.zip\n.\nLib\\site-packages\nimport site\n');
    assert.equal(f.downloads(), 0);
  } finally { f.close(); }
});

test('an interrupted extraction can be retried even after python.exe appears', async () => {
  const f = fixture();
  try {
    await assert.rejects(ensureWindowsEmbeddedPython({ ...f.options, extract() {
      writeFileSync(join(f.directory, 'python.exe'), 'synthetic interrupted core');
      throw Error('synthetic interruption');
    } }), /synthetic interruption/);
    assert.equal(existsSync(join(f.directory, 'python.exe')), true);
    assert.equal(existsSync(join(f.directory, 'python-3.12.10-embed-amd64.repair.zip')), false);
    await ensureWindowsEmbeddedPython(f.options);
    assert.equal(f.downloads(), 2);
  } finally { f.close(); }
});

test('failed core validation triggers a repair and remains a clear failure if repair is still invalid', async () => {
  const f = fixture();
  try {
    f.populate(); writeFileSync(join(f.directory, 'python312.zip'), 'synthetic corrupt archive');
    await ensureWindowsEmbeddedPython(f.options);
    assert.equal(f.downloads(), 1);
    await assert.rejects(ensureWindowsEmbeddedPython({ ...f.options, probe: () => false }), /核心校验失败/);
    assert.equal(f.downloads(), 2);
    assert.equal(existsSync(join(f.directory, 'python-3.12.10-embed-amd64.repair.zip')), false);
  } finally { f.close(); }
});

test('interrupted download is removed and a subsequent attempt starts cleanly', async () => {
  const f = fixture();
  try {
    await assert.rejects(ensureWindowsEmbeddedPython({ ...f.options, download: async (_url, path) => {
      writeFileSync(path, 'partial synthetic download'); throw Error('synthetic network interruption');
    } }), /synthetic network interruption/);
    assert.equal(existsSync(join(f.directory, 'python-3.12.10-embed-amd64.repair.zip')), false);
    await ensureWindowsEmbeddedPython(f.options);
    assert.equal(f.downloads(), 1);
  } finally { f.close(); }
});

test('nonexistent interpreter probe fails closed without discovering another Python', () => {
  const f = fixture();
  try { assert.equal(pythonCommandUsable(join(f.directory, 'missing-python.exe'), ['-I', '-m', 'pip', '--version']), false); }
  finally { f.close(); }
});
