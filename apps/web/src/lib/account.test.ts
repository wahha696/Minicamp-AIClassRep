// 修复计划第一节 §4：换号后 localStorage 按 uin 分键——
// 新号读不到旧号的「跳过引导 / 接管提示 / 群预设」，换回旧号原样回来。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountKey, currentUin, setCurrentUin } from './account';
import { loadPresets, savePresets } from './groups';
import { readAccountFlag, writeAccountFlag } from './status';

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => {
  setCurrentUin(null);
  vi.unstubAllGlobals();
});

describe('账号限定的存储键（修复计划第一节 §4）', () => {
  it('未登录键保持原样；登录后带 @uin；退出后回到原样', () => {
    setCurrentUin(undefined);
    expect(accountKey('classrep.x')).toBe('classrep.x');
    setCurrentUin('10001');
    expect(accountKey('classrep.x')).toBe('classrep.x@10001');
    expect(currentUin()).toBe('10001');
    setCurrentUin(null);
    expect(accountKey('classrep.x')).toBe('classrep.x');
  });

  it('群预设按号隔离：A 存的预设 B 读不到，换回 A 还在', () => {
    stubStorage();
    setCurrentUin('10001');
    savePresets([{ name: '重要', ids: ['1'] }]);

    setCurrentUin('20002');
    expect(loadPresets()).toEqual([]); // 新号是干净的一套

    setCurrentUin('10001');
    expect(loadPresets()).toEqual([{ name: '重要', ids: ['1'] }]); // 旧号原样回来
  });

  it('账号旗标按号隔离：skipConnect 之类不串号', () => {
    stubStorage();
    setCurrentUin('10001');
    writeAccountFlag('skipConnect', '1');

    setCurrentUin('20002');
    expect(readAccountFlag('skipConnect')).toBeNull();

    setCurrentUin('10001');
    expect(readAccountFlag('skipConnect')).toBe('1');
  });
});
