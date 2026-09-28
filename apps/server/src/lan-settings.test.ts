import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({
  state: 'ready' as 'ready' | 'switching' | 'error',
  uin: '10001' as string | null,
  epoch: 'epoch-a',
}));

vi.mock('./accounts.js', () => ({
  accountDataState: () => account.state,
  accountEpoch: () => account.epoch,
  currentAccount: () => account.uin,
}));

import {
  currentLanToken,
  lanConfiguredEnabled,
  lanEnabledAtBoot,
  rotateLanToken,
  setLanEnabled,
  setLanSettingsDir,
} from './lan-settings.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'classrep-lan-settings-'));
  setLanSettingsDir(dir);
  account.state = 'ready';
  account.uin = '10001';
  account.epoch = 'epoch-a';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LAN 链接账号绑定', () => {
  it('开启时绑定当前账号与数据代次', () => {
    const saved = setLanEnabled(true);

    expect(lanEnabledAtBoot()).toBe(true);
    expect(lanConfiguredEnabled()).toBe(true);
    expect(currentLanToken()).toBe(saved.token);
    expect(JSON.parse(readFileSync(join(dir, 'lan.json'), 'utf8'))).toMatchObject({
      enabled: true,
      token: saved.token,
      account_uin: '10001',
      account_epoch: 'epoch-a',
    });
  });

  it('换号、换代次和切库窗口都会让旧链接失效', () => {
    const old = setLanEnabled(true).token;

    account.uin = '20002';
    account.epoch = 'epoch-b';
    expect(currentLanToken()).toBeNull();
    expect(lanConfiguredEnabled()).toBe(true);

    account.uin = '10001';
    expect(currentLanToken()).toBeNull();

    account.epoch = 'epoch-a';
    account.state = 'switching';
    expect(currentLanToken()).toBeNull();

    account.state = 'ready';
    expect(currentLanToken()).toBe(old);
  });

  it('在新账号重新开启会换 token 并绑定新账号，旧链接不复活', () => {
    const old = setLanEnabled(true).token;
    account.uin = '20002';
    account.epoch = 'epoch-b';

    const rebound = setLanEnabled(true);
    expect(rebound.token).not.toBe(old);
    expect(currentLanToken()).toBe(rebound.token);
    expect(JSON.parse(readFileSync(join(dir, 'lan.json'), 'utf8'))).toMatchObject({
      account_uin: '20002',
      account_epoch: 'epoch-b',
    });
  });

  it('换新链接会绑定当前账号；关闭后不对外提供 token', () => {
    setLanEnabled(true);
    account.uin = '20002';
    account.epoch = 'epoch-b';
    const rotated = rotateLanToken();
    expect(currentLanToken()).toBe(rotated.token);

    setLanEnabled(false);
    expect(lanConfiguredEnabled()).toBe(false);
    expect(currentLanToken()).toBeNull();
  });

  it('升级前没有账号绑定的旧配置按失效处理', () => {
    writeFileSync(
      join(dir, 'lan.json'),
      `${JSON.stringify({ enabled: true, token: 'legacy-token-123456789' })}\n`,
      'utf8',
    );
    setLanSettingsDir(dir);

    expect(lanEnabledAtBoot()).toBe(true);
    expect(lanConfiguredEnabled()).toBe(true);
    expect(currentLanToken()).toBeNull();
  });
});
