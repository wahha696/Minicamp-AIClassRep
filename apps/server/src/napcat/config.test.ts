// A2 验收（A-采集端与打包.md A2）：vitest 用临时目录测 writeNapcatConfig，
// 检查三类文件内容；临时目录名本身含中文和空格，覆盖中文/空格路径场景。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { onebot11Config, writeNapcatConfig } from './config.js';
import { parseUninstallString } from './paths.js';

const tempDirs: string[] = [];

function tempNapcatDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ClassRep 中文 路径-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSyncQuiet(dir);
  }
});

function rmSyncQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
}

/** 架构.md §4.1 的字面内容——测试以它为契约，不直接引用 onebot11Config() 的返回值 */
const ONEBOT11_EXPECTED = {
  network: {
    httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
    websocketServers: [{
      name: 'classrep', enable: true, host: '127.0.0.1', port: 3001,
      messagePostFormat: 'array', reportSelfMessage: true, token: '',
      enableForcePushEvent: true, debug: false, heartInterval: 30000,
    }],
  },
  musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
};

describe('writeNapcatConfig', () => {
  it('配置目录不存在时创建，并写出三类文件；onebot11 内容与架构.md §4.1 一致', () => {
    const napcatDir = tempNapcatDir();
    writeNapcatConfig(napcatDir);

    const cfgDir = join(napcatDir, 'config');
    expect(JSON.parse(readFileSync(join(cfgDir, 'onebot11.json'), 'utf8'))).toEqual(ONEBOT11_EXPECTED);

    // webui.json 原本不存在 → 只写 disableWebUI
    expect(JSON.parse(readFileSync(join(cfgDir, 'webui.json'), 'utf8'))).toEqual({ disableWebUI: true });

    // loadNapCat.js：pathToFileURL，中文/空格路径会被编码
    const entry = pathToFileURL(join(napcatDir, 'napcat.mjs')).href;
    expect(readFileSync(join(napcatDir, 'loadNapCat.js'), 'utf8'))
      .toBe(`(async () => {await import("${entry}")})()`);
  });

  it('把已存在的每个 onebot11_*.json 覆盖成同一份内容，不碰其他文件', () => {
    const napcatDir = tempNapcatDir();
    const cfgDir = join(napcatDir, 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'onebot11.json'), '旧模板', 'utf8');
    writeFileSync(join(cfgDir, 'onebot11_10000.json'), '{"network":{}}', 'utf8');
    writeFileSync(join(cfgDir, 'onebot11_20000.json'), '垃圾内容', 'utf8');
    writeFileSync(join(cfgDir, 'onebot11_10000.json.bak'), '备份不能动', 'utf8');

    writeNapcatConfig(napcatDir);

    const expected = JSON.stringify(ONEBOT11_EXPECTED, null, 2);
    expect(readFileSync(join(cfgDir, 'onebot11.json'), 'utf8')).toBe(expected);
    expect(readFileSync(join(cfgDir, 'onebot11_10000.json'), 'utf8')).toBe(expected);
    expect(readFileSync(join(cfgDir, 'onebot11_20000.json'), 'utf8')).toBe(expected);
    // 不匹配 onebot11_*.json 的文件保持原样
    expect(readFileSync(join(cfgDir, 'onebot11_10000.json.bak'), 'utf8')).toBe('备份不能动');
  });

  it('webui.json 保留其他字段，只把 disableWebUI 改为 true', () => {
    const napcatDir = tempNapcatDir();
    const cfgDir = join(napcatDir, 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'webui.json'), '{"port":6099,"token":"abc","disableWebUI":false}', 'utf8');

    writeNapcatConfig(napcatDir);

    expect(JSON.parse(readFileSync(join(cfgDir, 'webui.json'), 'utf8')))
      .toEqual({ port: 6099, token: 'abc', disableWebUI: true });
  });

  it('webui.json 内容非法时退回 {}，仍写出 disableWebUI', () => {
    const napcatDir = tempNapcatDir();
    const cfgDir = join(napcatDir, 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'webui.json'), '{{{不是JSON', 'utf8');

    writeNapcatConfig(napcatDir);

    expect(JSON.parse(readFileSync(join(cfgDir, 'webui.json'), 'utf8'))).toEqual({ disableWebUI: true });
  });
});

describe('parseUninstallString', () => {
  it('解析 reg query 输出：不带引号 / 带引号 / 匹配不到', () => {
    expect(parseUninstallString(
      '\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ\r\n' +
      '    UninstallString    REG_SZ    D:\\Uninstall.exe\r\n',
    )).toBe('D:\\Uninstall.exe');

    expect(parseUninstallString(
      '    UninstallString    REG_SZ    "C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"',
    )).toBe('C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe');

    expect(parseUninstallString('系统找不到指定的注册表项或值。')).toBeNull();
  });
});
