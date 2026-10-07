// Verify the actual ZIP after Windows extraction, without a system Node/Python or QQ login.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const zip = resolve(process.argv[2] ?? join(repo, 'release', 'ClassRep.zip'));
const expectedVersion = process.argv[3]?.replace(/^v/, '');
assert.equal(process.platform, 'win32', 'Windows release verification requires Windows');
const scratch = mkdtempSync(join(tmpdir(), 'classrep-release-验收 '));
const install = join(scratch, 'ClassRep');
let launcher;
let output = '';
const stopMarker = join(scratch, 'stop.txt');
try {
  const extraction = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    '[IO.Compression.ZipFile]::ExtractToDirectory($env:CLASSREP_SMOKE_ZIP,$env:CLASSREP_SMOKE_DIR)',
  ], {
    env: { ...process.env, CLASSREP_SMOKE_ZIP: zip, CLASSREP_SMOKE_DIR: scratch },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(extraction.status, 0, `ZIP extraction failed: ${extraction.stderr}`);
  for (const file of [
    '启动.bat', '修复升级.bat', '修复升级.ps1', 'runtime/node.exe',
    'scripts/windows-acceptance.ps1', 'Windows真机验收.md',
    'app/server/dist/index.js', 'app/web/dist/index.html',
    'app/version.json', 'napcat/NapCatWinBootMain.exe', 'napcat/NapCatWinBootHook.dll',
    'napcat/napcat.mjs', 'classrep-fastjudge/py/python.exe',
    'classrep-fastjudge/models/local-jev-v1.joblib',
  ]) assert.ok(existsSync(join(install, file)), `Extracted release missing ${file}`);
  const version = JSON.parse(readFileSync(join(install, 'app/version.json'), 'utf8')).version;
  if (expectedVersion) assert.equal(version, expectedVersion, 'ZIP version does not match tag');

  // Observe the browser launch while keeping the test invisible and offline.
  // The real batch file must enable it; setting the flag here would hide the regression.
  const marker = join(scratch, 'browser.txt');
  const hook = join(scratch, 'observe-browser.mjs');
  writeFileSync(hook, `import cp from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.exec;
cp.exec=(command,...args)=>{
  if(/^start "" http:\\/\\/localhost:\\d+$/.test(command)){
    writeFileSync(${JSON.stringify(marker)},command);
    return;
  }
  return original(command,...args);
};
syncBuiltinESMExports();
globalThis.fetch=()=>Promise.reject(new Error('release smoke: network disabled'));
const stopper=setInterval(()=>{
  if(!existsSync(${JSON.stringify(stopMarker)})) return;
  clearInterval(stopper);
  if(process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
},100);
stopper.unref();
`);
  const testEnv = { ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
    ONEBOT_WS_URL: 'ws://127.0.0.1:1', // Do not launch or interrupt desktop QQ.
  };
  for (const key of ['CLASSREP_OPEN_BROWSER', 'AUTO_EXIT', 'LLM_API_KEY', 'TYPESAFE_API_KEY',
    'FASTJUDGE_ROOT', 'FASTJUDGE_PYTHON', 'LOCAL_JEV_MODEL_PATH']) delete testEnv[key];
  launcher = spawn('cmd.exe', ['/d', '/c', '启动.bat'], {
    cwd: install, env: testEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  launcher.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  let spawnError;
  launcher.on('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 60_000;
  let base;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(launcher.exitCode, null, `Launcher exited early:\n${output}`);
    const match = output.match(/http:\/\/localhost:(\d+)/);
    if (match && existsSync(marker)) {
      base = `http://localhost:${match[1]}`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(base, `No browser launch within 60 seconds:\n${output}`);
  assert.equal(readFileSync(marker, 'utf8'), `start "" ${base}`);
  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.db, 'ok', JSON.stringify(health));
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.(?:js|css))"/g)];
  assert.ok(assets.length >= 2, 'No frontend JS/CSS references');
  for (const [, asset] of assets) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type'), asset.endsWith('.js') ? /javascript/ : /text\/css/);
  }
  const python = spawnSync(join(install, 'classrep-fastjudge/py/python.exe'), [
    '-X', 'utf8', join(install, 'classrep-fastjudge/src/infer.py'),
    '--file', join(install, 'classrep-fastjudge/smoke-utf8.json'),
  ], { cwd: install, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(python.status, 0, python.stderr || python.stdout);
  const { scores } = JSON.parse(python.stdout);
  assert.equal(scores.length, 4);
  assert.ok(scores[2] >= 0.2, `Exam message score too low: ${scores}`);
  assert.ok(scores[1] < 0.2, `Chat message score too high: ${scores}`);
  console.log(`Release v${version} OK: ZIP filenames, batch startup, browser, DB, web assets, local model`);
} finally {
  if (launcher?.pid) {
    // Graceful shutdown also works where Windows process-control tools are restricted.
    writeFileSync(stopMarker, 'stop');
    await new Promise((resolve) => {
      if (launcher.exitCode !== null || launcher.signalCode !== null) return resolve();
      launcher.once('exit', resolve);
      setTimeout(resolve, 5_000).unref();
    });
    if (launcher.exitCode === null && launcher.signalCode === null) {
      const killed = spawnSync('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], {
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(killed.status, 0, `Cannot stop release test process: ${killed.stderr}`);
    }
  }
  // Only remove the uniquely created test directory under the system temp folder.
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
  assert.ok(scratch.split(sep).at(-1).startsWith('classrep-release-'));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
