// 真正运行更新器，在临时安装目录注入文件操作故障；不访问用户安装和数据。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function archivePayload(payload, zip) {
  if (process.platform === 'win32') {
    return spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:CLASSREP_TEST_PAYLOAD -DestinationPath $env:CLASSREP_TEST_ARCHIVE -Force",
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLASSREP_TEST_PAYLOAD: payload,
        CLASSREP_TEST_ARCHIVE: zip,
      },
    });
  }
  return spawnSync('tar', ['-cf', zip, '-C', dirname(payload), 'ClassRep'], { encoding: 'utf8' });
}

function fixture(t, realRuntime = false) {
  const root = mkdtempSync(join(tmpdir(), 'classrep-update-test-'));
  t.after(() => {
    // 递归清理只允许本测试刚创建的临时目录。
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.split(sep).at(-1).startsWith('classrep-update-test-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const install = join(root, '安装 目录');
  const payload = join(root, 'payload', 'ClassRep');
  const work = join(install, 'data', 'update');
  const write = (base, path, content) => {
    const target = join(base, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write(install, 'app/server/dist/index.js', 'old-app');
  write(install, 'runtime/node.exe', 'old-runtime');
  write(install, 'runtime/extra.txt', 'old-extra');
  write(install, 'data/user.json', 'user-data');
  write(payload, 'app/server/dist/index.js', 'new-app');
  write(payload, 'runtime/node.exe', 'new-runtime');
  write(payload, 'runtime/extra.txt', 'new-extra');
  write(payload, 'runtime/z-added.txt', 'new-runtime-file');
  write(payload, 'new-component/model.txt', 'new-model');
  write(payload, 'data/user.json', 'must-not-overwrite');
  mkdirSync(work, { recursive: true });
  cpSync(join(repo, 'scripts/update.mjs'), join(install, 'app/update.mjs'));
  if (realRuntime) {
    rmSync(join(install, 'runtime/node.exe'));
    cpSync(process.execPath, join(install, 'runtime/node.exe'));
    cpSync(process.execPath, join(payload, 'runtime/node.exe'));
    write(install, 'app/server/dist/index.js',
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(install, 'launched.txt'))}, 'old-app');`);
    write(payload, 'app/server/dist/index.js',
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(install, 'launched.txt'))}, 'new-app');`);
    cpSync(join(repo, '启动.bat'), join(install, '启动.bat'));
    cpSync(join(repo, '启动.bat'), join(payload, '启动.bat'));
  }
  // Windows 上生成与真实 Release 相同的 ZIP；安装路径特意含中文和空格。
  const zip = join(root, 'payload.zip');
  const archive = archivePayload(payload, zip);
  assert.equal(archive.status, 0, `${archive.stdout ?? ''}\n${archive.stderr ?? ''}`);
  if (process.platform === 'win32') {
    assert.equal(readFileSync(zip).subarray(0, 2).toString('ascii'), 'PK');
  }
  writeFileSync(join(work, 'pending.json'), JSON.stringify({
    zip, to: 'test', sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
  }));
  const journal = () => JSON.parse(readFileSync(join(work, 'transaction.json'), 'utf8'));
  const text = (path) => readFileSync(join(install, path), 'utf8');
  const has = (path) => existsSync(join(install, path));
  const run = ({ hook = '', recover = false } = {}) => {
    const args = [];
    if (hook) {
      const module = join(root, 'fault.mjs');
      writeFileSync(module, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const install=${JSON.stringify(install)}, work=${JSON.stringify(work)};
const rename=fs.renameSync, copy=fs.cpSync, remove=fs.rmSync;
${hook}
syncBuiltinESMExports();`);
      args.push('--import', pathToFileURL(module).href);
    }
    args.push(recover ? join(work, 'recover.mjs') : join(install, 'app/update.mjs'));
    if (recover) args.push('--recover-only');
    return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
  };
  const old = () => {
    assert.equal(text('app/server/dist/index.js'), 'old-app');
    assert.equal(text('runtime/node.exe'), 'old-runtime');
    assert.equal(text('runtime/extra.txt'), 'old-extra');
    assert.equal(has('runtime/z-added.txt'), false);
    assert.equal(has('new-component'), false);
    assert.equal(text('data/user.json'), 'user-data');
  };
  return { root, install, payload, work, zip, run, text, has, old, journal };
}

test('完整更新：所有组件切换，用户数据保留，待更新信息清除', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.text('app/server/dist/index.js'), 'new-app');
  assert.equal(f.text('runtime/node.exe'), 'new-runtime');
  assert.equal(f.text('runtime/extra.txt'), 'new-extra');
  assert.equal(f.text('new-component/model.txt'), 'new-model');
  assert.equal(f.text('data/user.json'), 'user-data');
  assert.equal(f.has('data/update/pending.json'), false);
  assert.equal(f.has('data/update/transaction.json'), false);
});

test('预备文件复制失败：安装未改动，也没有开始事务', (t) => {
  const f = fixture(t);
  const result = f.run({ hook: `fs.cpSync=(src,dst,opts)=>{
    if(dst===join(work,'new','app')) throw new Error('prepare denied');
    return copy(src,dst,opts);
  };` });
  assert.equal(result.status, 1);
  f.old();
  assert.equal(f.has('data/update/transaction.json'), false);
});

for (const phase of ['old', 'new']) {
  test(`${phase === 'old' ? '移走旧目录' : '放入新目录'}失败：完整恢复旧版`, (t) => {
    const f = fixture(t);
    const source = phase === 'old' ? "join(install,'app')" : "join(work,'new','app')";
    const result = f.run({ hook: `fs.renameSync=(src,dst)=>{
      if(src===${source}) throw new Error('rename denied');
      return rename(src,dst);
    };` });
    assert.equal(result.status, 1);
    f.old();
    assert.equal(f.has('data/update/transaction.json'), false);
    assert.equal(f.has('data/update/pending.json'), true);
  });
}

test('运行时最后一步失败：已替换的 Node、其他文件和新增组件全部回滚', (t) => {
  const f = fixture(t);
  const result = f.run({ hook: `fs.renameSync=(src,dst)=>{
    if(src===join(work,'new','runtime','z-added.txt')) throw new Error('runtime denied');
    return rename(src,dst);
  };` });
  assert.equal(result.status, 1);
  f.old();
  assert.equal(f.has('data/update/transaction.json'), false);
});

test('回滚也失败：保留记录和备份，下次无更新包也能继续恢复', (t) => {
  const f = fixture(t);
  const result = f.run({ hook: `fs.renameSync=(src,dst)=>{
    if(src===join(work,'new','app') || src===join(work,'old','app')) throw new Error('app locked');
    return rename(src,dst);
  };` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /回滚尚未完成/);
  assert.doesNotMatch(result.stdout, /已恢复到完整旧版/);
  assert.equal(f.has('data/update/old/app/server/dist/index.js'), true);
  assert.equal(f.journal().state, 'switching');
  rmSync(f.zip);
  const recovery = f.run({ recover: true });
  assert.equal(recovery.status, 0, recovery.stderr);
  f.old();
  assert.equal(f.has('data/update/transaction.json'), false);
});

for (const path of ['app', 'runtime/node.exe']) {
  test(`进程在移走 ${path} 后退出：独立恢复入口可恢复`, (t) => {
    const f = fixture(t);
    const result = f.run({ hook: `fs.renameSync=(src,dst)=>{
      const result=rename(src,dst);
      if(src===join(install,...${JSON.stringify(path.split('/'))})) process.exit(77);
      return result;
    };` });
    assert.equal(result.status, 77);
    assert.equal(f.has(path), false);
    assert.equal(f.journal().state, 'switching');
    assert.equal(f.has('data/update/recover.mjs'), true);
    assert.equal(f.has('data/update/recovery-node.exe'), true);
    const recovery = f.run({ recover: true });
    assert.equal(recovery.status, 0, recovery.stderr);
    f.old();
    // 重复调用恢复入口无副作用。
    assert.equal(f.run({ recover: true }).status, 0);
    f.old();
  });
}

test('Windows 恢复受阻：保留备份并停止，不能启动不完整安装',
  { skip: process.platform !== 'win32' }, (t) => {
    const f = fixture(t, true);
    const result = f.run({ hook: `fs.renameSync=(src,dst)=>{
      if(src===join(work,'new','app') || src===join(work,'old','app')) throw new Error('app locked');
      return rename(src,dst);
    };` });
    assert.equal(result.status, 1);
    const start = spawnSync('cmd.exe', ['/d', '/c', '启动.bat'], {
      cwd: f.install, encoding: 'utf8', input: '\n', timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(join(f.root, 'fault.mjs')).href}` },
    });
    assert.equal(start.status, 1, `${start.stdout}\n${start.stderr}`);
    assert.equal(f.has('launched.txt'), false);
    assert.equal(f.has('data/update/old/app/server/dist/index.js'), true);
    assert.equal(f.journal().state, 'switching');
    assert.equal(f.text('data/user.json'), 'user-data');
  });

test('提交完成后退出：下次只清理，保留已完整安装的新版', (t) => {
  const f = fixture(t);
  const result = f.run({ hook: `let writes=0; fs.renameSync=(src,dst)=>{
    const result=rename(src,dst);
    if(dst===join(work,'transaction.json') && ++writes===2) process.exit(77);
    return result;
  };` });
  assert.equal(result.status, 77);
  assert.equal(f.journal().state, 'committed');
  assert.equal(f.run({ recover: true }).status, 0);
  assert.equal(f.text('app/server/dist/index.js'), 'new-app');
  assert.equal(f.text('runtime/node.exe'), 'new-runtime');
  assert.equal(f.has('data/update/pending.json'), false);
  assert.equal(f.has('data/update/transaction.json'), false);
});

test('成功后的清理失败：保留 committed 记录，恢复时不会退回旧版', (t) => {
  const f = fixture(t);
  const result = f.run({ hook: `fs.rmSync=(path,opts)=>{
    if(path===join(work,'pending.json')) throw new Error('cleanup denied');
    return remove(path,opts);
  };` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.journal().state, 'committed');
  assert.equal(f.run({ recover: true }).status, 0);
  assert.equal(f.text('app/server/dist/index.js'), 'new-app');
  assert.equal(f.text('runtime/node.exe'), 'new-runtime');
});

test('Windows 完整更新：实际运行的 Node 被替换后，独立进程清理备份再启动新版',
  { skip: process.platform !== 'win32' }, (t) => {
    const f = fixture(t, true);
    const start = spawnSync('cmd.exe', ['/d', '/c', '启动.bat'], {
      cwd: f.install, encoding: 'utf8', input: '\n', timeout: 30_000,
    });
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.equal(f.text('launched.txt'), 'new-app');
    assert.equal(f.has('data/update/transaction.json'), false);
    assert.equal(f.has('data/update/pending.json'), false);
    assert.equal(f.has('data/update/old'), false);
  });

test('SHA 不匹配：隔离更新包，安装和用户数据未改动', (t) => {
  const f = fixture(t);
  const pending = JSON.parse(f.text('data/update/pending.json'));
  pending.sha256 = '0'.repeat(64);
  writeFileSync(join(f.work, 'pending.json'), JSON.stringify(pending));
  assert.equal(f.run().status, 1);
  f.old();
  assert.equal(f.has('data/update/pending.json.failed.json'), true);
  assert.equal(existsSync(`${f.zip}.bad`), true);
  assert.equal(f.has('data/update/transaction.json'), false);
});

test('损坏的恢复记录：停止恢复并保留备份，不能越界改动用户数据', (t) => {
  const f = fixture(t);
  cpSync(join(repo, 'scripts/update.mjs'), join(f.work, 'recover.mjs'));
  writeFileSync(join(f.work, 'transaction.json'), JSON.stringify({
    version: 1, state: 'switching', entries: [{ path: 'data/user.json', hadOriginal: false }],
  }));
  assert.equal(f.run({ recover: true }).status, 1);
  f.old();
  assert.equal(f.has('data/update/transaction.json'), true);
});

for (const path of ['app', 'runtime/node.exe']) {
  test(`Windows 启动器：${path} 缺失时先恢复，再启动旧版`, { skip: process.platform !== 'win32' }, (t) => {
    const f = fixture(t, true);
    const result = f.run({ hook: `fs.renameSync=(src,dst)=>{
      const result=rename(src,dst);
      if(src===join(install,...${JSON.stringify(path.split('/'))})) process.exit(77);
      return result;
    };` });
    assert.equal(result.status, 77);
    assert.equal(f.has(path), false);
    const start = spawnSync('cmd.exe', ['/d', '/c', '启动.bat'], {
      cwd: f.install, encoding: 'utf8', input: '\n', timeout: 30_000,
    });
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.equal(f.text('launched.txt'), 'old-app');
    assert.equal(f.has('data/update/transaction.json'), false);
    assert.equal(f.has('data/update/pending.json'), true);
  });
}
