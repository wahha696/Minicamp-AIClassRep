import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/error';
import type { ConnectState, ConnectStatusDTO, HealthDTO } from '../api/types';
import { errorText } from './errors';
import { bannerFor, ERROR_FALLBACK, lightsFromHealth, shouldRedirectToConnect } from './status';

const health = (over: Partial<HealthDTO> = {}): HealthDTO => ({
  status: 'ok', db: 'ok', qq: 'online', llm: 'ok', jev: 'disabled',
  filtered_count: 0, jev_filtered_count: 0, jev_called_count: 0, llm_called_count: 0, uptime: 1, pending: 0, ...over,
});
const status = (state: ConnectState, over: Partial<ConnectStatusDTO> = {}): ConnectStatusDTO => ({
  state, since: 0, first_run: false, account_epoch: 'none:1', ...over,
});

describe('状态灯', () => {
  it('未启用快判：前三个绿，快判灰色', () => {
    const l = lightsFromHealth(health());
    expect(l.map((x) => [x.label, x.color])).toEqual([
      ['QQ', 'green'], ['数据库', 'green'], ['AI', 'green'], ['快判', 'gray'],
    ]);
    expect(l[3].tip).toContain('已关闭');
  });

  it('快判正常为绿，失败或缺 key 为红且提示继续走 AI', () => {
    expect(lightsFromHealth(health({ jev: 'ok' }))[3].color).toBe('green');
    expect(lightsFromHealth(health({ jev: 'error' }))[3].tip).toContain('消息已交给 AI');
    expect(lightsFromHealth(health({ jev: 'unconfigured' }))[3].color).toBe('red');
  });

  it('快判灯标出本地/双路后端', () => {
    const local = lightsFromHealth(health({ jev: 'ok', jev_mode: 'local', jev_local: 'ok' }))[3];
    expect(local.label).toBe('本地快判');
    expect(local.tip).toContain('本地模型');
    const dual = lightsFromHealth(health({ jev: 'ok', jev_mode: 'dual', jev_route: 'local', jev_local: 'ok' }))[3];
    expect(dual.label).toBe('双路快判');
    expect(dual.tip).toContain('路由=本地');
    expect(lightsFromHealth(health({ jev: 'ok', jev_mode: 'dual', jev_route: 'jev', jev_local: 'backoff' }))[3].tip)
      .toContain('本地模型退避中');
    const miss = lightsFromHealth(health({ jev: 'unconfigured', jev_mode: 'local', jev_local: 'unconfigured' }))[3];
    expect(miss.color).toBe('red');
    expect(miss.tip).toContain('本地快判：模型未就绪');
  });

  it('QQ 非 online、db 异常、llm error/unconfigured 都是红，悬停说明为中文', () => {
    const l = lightsFromHealth(health({ qq: 'kicked', db: 'error', llm: 'unconfigured' }));
    expect(l.map((x) => x.color)).toEqual(['red', 'red', 'red', 'gray']);
    expect(l[0].tip).toBe('QQ 连接：你的 QQ 在另一台电脑登录了，采集已暂停');
    expect(l[2].tip).toBe('AI：未配置');
    expect(lightsFromHealth(health({ llm: 'error' }))[2].color).toBe('red');
  });

  it('读不到 /health → 除快判外全红', () => {
    expect(lightsFromHealth(undefined).map((x) => x.color)).toEqual(['red', 'red', 'red', 'gray']);
  });

  it('任何文案都不出现 NapCat', () => {
    const states: ConnectState[] = ['qq_conflict', 'error', 'kicked', 'online', 'waiting_qr', 'reconnecting', 'starting'];
    const texts = [
      ...states.flatMap((s) => lightsFromHealth(health({ qq: s })).map((x) => x.tip)),
      ...states.map((s) => JSON.stringify(bannerFor(status(s), '/'))),
      JSON.stringify(lightsFromHealth(undefined)),
    ];
    expect(texts.join('').toLowerCase()).not.toContain('napcat');
  });
});

describe('连接黄条', () => {
  it('online 不显示', () => {
    expect(bannerFor(status('online'), '/')).toBeNull();
    expect(bannerFor(undefined, '/')).toBeNull();
  });

  it('reconnecting：只有文字', () => {
    expect(bannerFor(status('reconnecting'), '/')).toEqual({ kind: 'reconnecting', text: '连接中断，重连中' });
  });

  it('kicked：文案 + 「重新连接」', () => {
    expect(bannerFor(status('kicked'), '/week')).toMatchObject({
      text: '你的 QQ 在另一台电脑登录了，采集已暂停', action: 'restart', actionText: '重新连接',
    });
  });

  it('error：显示后端 message + 「重启采集端」；没有 message 用 §7 默认文案', () => {
    expect(bannerFor(status('error', { message: '需要先安装 QQ 电脑版' }), '/')).toMatchObject({
      text: '需要先安装 QQ 电脑版', actionText: '重启采集端',
    });
    expect(bannerFor(status('error'), '/')!.text).toBe(ERROR_FALLBACK);
  });

  it('qq_conflict / waiting_qr / starting：不在 /connect 时「QQ 未连接」+「去连接」，在 /connect 时不显示', () => {
    for (const s of ['qq_conflict', 'waiting_qr', 'starting'] as const) {
      expect(bannerFor(status(s), '/groups')).toMatchObject({ text: 'QQ 未连接', linkTo: '/connect', linkText: '去连接' });
      expect(bannerFor(status(s), '/connect')).toBeNull();
    }
  });

  it('kicked / error 在 /connect 页也照样显示按钮', () => {
    expect(bannerFor(status('kicked'), '/connect')).not.toBeNull();
    expect(bannerFor(status('error'), '/connect')).not.toBeNull();
  });
});

describe('路由守卫', () => {
  it('first_run 时拦到 /connect', () => {
    expect(shouldRedirectToConnect(status('waiting_qr', { first_run: true }), '/', false)).toBe(true);
    expect(shouldRedirectToConnect(status('waiting_qr', { first_run: true }), '/demo', false)).toBe(true);
  });
  it('已在 /connect、点过「演示模式」、非 first_run、状态未知 → 不拦', () => {
    expect(shouldRedirectToConnect(status('waiting_qr', { first_run: true }), '/connect', false)).toBe(false);
    expect(shouldRedirectToConnect(status('waiting_qr', { first_run: true }), '/demo', true)).toBe(false);
    expect(shouldRedirectToConnect(status('kicked'), '/', false)).toBe(false);
    expect(shouldRedirectToConnect(undefined, '/', false)).toBe(false);
  });
});

describe('错误文案', () => {
  it('403 → 请在电脑上操作；其他用后端 error 字段', () => {
    expect(errorText(new ApiError('禁止', 403))).toBe('请在电脑上操作');
    expect(errorText(new ApiError('QQ 未连接', 409))).toBe('QQ 未连接');
    expect(errorText('x')).toBe('操作失败，请重试');
  });
});
