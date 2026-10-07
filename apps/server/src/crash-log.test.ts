// B7 审核：崩溃日志不能因 EPIPE 死循环、不能把磁盘写满
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LOG_BYTES, createCrashLogger } from './crash-log.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'classrep-crash-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

describe('createCrashLogger', () => {
  it('打印中文 + 追加写日志文件（目录按需创建）', () => {
    const file = join(dir, 'logs', 'server.log');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createCrashLogger(file);
    log('未捕获异常', new Error('坏消息'));
    log('未处理的 Promise 拒绝', 'x');
    expect(err).toHaveBeenCalledTimes(2);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('未捕获异常：Error: 坏消息');
    expect(text).toContain('未处理的 Promise 拒绝：x');
  });

  it('console.error 自己抛错（管道断了）也不抛出、不递归，照样写文件', () => {
    const file = join(dir, 'server.log');
    const log = createCrashLogger(file);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {
      // 模拟：打印时又触发一次崩溃处理
      log('未捕获异常', new Error('EPIPE'));
      throw new Error('EPIPE: broken pipe, write');
    });
    expect(() => log('未捕获异常', new Error('原始错误'))).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1); // 重入被挡掉
    expect(readFileSync(file, 'utf8')).toContain('原始错误');
  });

  it('日志文件超过上限后不再追加', () => {
    const file = join(dir, 'server.log');
    writeFileSync(file, Buffer.alloc(MAX_LOG_BYTES));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createCrashLogger(file)('未捕获异常', new Error('不该写进去'));
    expect(statSync(file).size).toBe(MAX_LOG_BYTES);
  });

  it('崩溃栈中的 Key、token 和用户目录会先脱敏', () => {
    const file = join(dir, 'server.log');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createCrashLogger(file)('未捕获异常', new Error('Bearer secret-token /Users/alice/ClassRep API_KEY=sk-private123'));
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('sk-private123');
    expect(text).toContain('[REDACTED]');
  });
});

describe('installCrashHandlers（真实子进程）', () => {
  it('stdout/stderr 管道断开后再触发异常：不死循环，日志只有 1 条', async () => {
    const file = join(dir, 'server.log');
    const modUrl = pathToFileURL(join(import.meta.dirname, 'crash-log.ts')).href;
    const script = `
      const { installCrashHandlers } = await import(${JSON.stringify(modUrl)});
      installCrashHandlers(${JSON.stringify(file)});
      process.stdin.once('data', () => {
        setTimeout(() => { throw new Error('管道断开后的异常'); }, 50);
        setTimeout(() => process.exit(0), 1500);
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 等子进程起来后关掉它的 stdout/stderr 读端（= 用户关掉了终端）
    await new Promise((r) => setTimeout(r, 1500));
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.write('go\n');
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.match(/未捕获异常/g)?.length).toBe(1);
    expect(text).not.toContain('EPIPE');
  }, 15_000);
});
