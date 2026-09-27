// A5 验收：状态判定顺序（架构.md §4 表格自上而下）+ §7 文案 + 非 Windows 返回。
import { describe, expect, it } from 'vitest';
import { deriveConnectStatus, type ConnectInputs } from './state.js';

function base(over: Partial<ConnectInputs> = {}): ConnectInputs {
  return {
    manager: { qqExe: 'D:\\QQ.exe', pid: 4321, conflictAtBoot: false, spawnFailed: false, crashLoop: false, recentExits: 0, napcatMissing: false },
    onebot: { wsConnected: false, everOnline: false, selfId: null, kicked: false },
    qrcodeExists: false,
    uin: undefined,
    deepseekConfigured: true,
    isWindows: true,
    ...over,
  };
}

const CONNECTED = { wsConnected: true, everOnline: true, selfId: '10001', kicked: false };

describe('deriveConnectStatus（架构.md §4，自上而下先命中为准）', () => {
  it('1. qq_conflict：启动时 QQ 在运行且尚未 spawn，文案为 §7 冲突提示', () => {
    const r = deriveConnectStatus(base({ manager: { ...base().manager, conflictAtBoot: true, pid: null } }));
    expect(r.state).toBe('qq_conflict');
    expect(r.message).toBe('ClassRep 需要接管电脑版 QQ，期间请用手机 QQ 聊天');
  });

  it('qq_conflict 优先于其他：即使 crashLoop 也在它之后判定不到（未 spawn 时 qq_conflict 先命中）', () => {
    const r = deriveConnectStatus(base({
      manager: { qqExe: null, pid: null, conflictAtBoot: true, spawnFailed: false, crashLoop: false, recentExits: 0, napcatMissing: false },
    }));
    expect(r.state).toBe('qq_conflict');
  });

  it('2a. error：找不到 QQ（qqExe=null）', () => {
    const r = deriveConnectStatus(base({ manager: { ...base().manager, qqExe: null } }));
    expect(r.state).toBe('error');
    expect(r.message).toBe('需要先安装 QQ 电脑版');
  });

  it('2b. error：60s 内退出 ≥3 次（crashLoop），文案为 §7 反复崩溃行', () => {
    const r = deriveConnectStatus(base({ manager: { ...base().manager, crashLoop: true, recentExits: 3 } }));
    expect(r.state).toBe('error');
    expect(r.message).toBe('采集端异常。常见原因是 QQ 版本过旧，请更新到最新版 QQ 后重试');
  });

  it('2c. error：spawn 失败', () => {
    const r = deriveConnectStatus(base({ manager: { ...base().manager, spawnFailed: true } }));
    expect(r.state).toBe('error');
  });

  it('3. kicked：bot_offline 后不自动重启（优先于 online 判定）', () => {
    const r = deriveConnectStatus(base({
      onebot: { wsConnected: false, everOnline: true, selfId: '10001', kicked: true },
      qrcodeExists: true,
    }));
    expect(r.state).toBe('kicked');
  });

  it('4. online：WS 已连上且已收到 lifecycle self_id', () => {
    const r = deriveConnectStatus(base({
      onebot: { wsConnected: true, everOnline: true, selfId: '10001', kicked: false },
      uin: '10001',
    }));
    expect(r.state).toBe('online');
    expect(r.uin).toBe('10001');
  });

  it('5. waiting_qr：进程在、WS 未连上、二维码已出现', () => {
    const r = deriveConnectStatus(base({ qrcodeExists: true }));
    expect(r.state).toBe('waiting_qr');
  });

  it('6. reconnecting：曾 online、WS 断开、进程还在', () => {
    const r = deriveConnectStatus(base({
      onebot: { wsConnected: false, everOnline: true, selfId: null, kicked: false },
      qrcodeExists: false,
      uin: '10001',
    }));
    expect(r.state).toBe('reconnecting');
  });

  it('7. starting：进程在，以上都不满足（二维码还没写出的窗口期）', () => {
    const r = deriveConnectStatus(base({ qrcodeExists: false }));
    expect(r.state).toBe('starting');
  });

  it('非 Windows：error + 00-总约定 §6 文案（开发模式可用演示回放）', () => {
    const r = deriveConnectStatus(base({ isWindows: false }));
    expect(r.state).toBe('error');
    expect(r.message).toBe('当前系统不支持采集端（开发模式，可用演示回放）');
  });

  it('first_run：没有 uin 或 LLM 未配置（修复计划第一节 §5）', () => {
    expect(deriveConnectStatus(base()).first_run).toBe(true); // 无 uin
    expect(deriveConnectStatus(base({ uin: '10001' })).first_run).toBe(false); // 登录过且配了 key
    expect(deriveConnectStatus(base({ uin: '10001', deepseekConfigured: false })).first_run).toBe(true); // 登录过但没配 key
  });

  it('error 状态的 uin 仍然返回（登录过的用户在任何状态下都能直接看日历）', () => {
    const r = deriveConnectStatus(base({ uin: '10001' }));
    expect(r.uin).toBe('10001');
  });
});

describe('缺 NapCat 运行包（四问题修复 #3：区分「缺 QQ」与「缺运行包」）', () => {
  it('QQ 在但 napcat/NapCatWinBootMain.exe 缺失 → error + no_napcat + 带动作的文案', () => {
    const r = deriveConnectStatus(base({ napcatInstalled: false }));
    expect(r.state).toBe('error');
    expect(r.reason).toBe('no_napcat');
    expect(r.message).toContain('一键下载 NapCat 组件');
  });

  it('没装 QQ 优先于缺运行包（先装 QQ 才谈得上下载组件）', () => {
    const r = deriveConnectStatus(base({ napcatInstalled: false, manager: { ...base().manager, qqExe: null } }));
    expect(r.state).toBe('error');
    expect(r.reason).toBe('no_qq');
  });

  it('napcatInstalled 缺省 = true（老调用方不受影响）', () => {
    expect(deriveConnectStatus(base()).reason).toBeUndefined();
  });
});
