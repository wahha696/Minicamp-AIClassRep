// 未捕获异常兜底：中文打印 + 追加写 data/logs/server.log，进程不退出。
// 单独成文件是为了能测（index.ts 有顶层 await 和监听）。
//
// B7 审核发现的死循环：终端关掉后 stdout/stderr 管道断开，console.error 触发 EPIPE →
// 流的 'error' 没人听 → 又成了 uncaughtException → 又 console.error …… 空转吃满 CPU，
// 十几分钟写出 2.7 GB 日志。所以这里：
//   1. 给 stdout/stderr 挂 'error' 监听，EPIPE 之类直接吞掉（管道断了本来就没人看）；
//   2. 处理器防重入，打印自己出错不再递归；
//   3. 日志文件超过上限就不再追加，磁盘不会被写满。
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** server.log 最大 10 MB，超过就只打印不写文件 */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** 返回 logCrash(kind, err)；logFile 可注入，方便测试 */
export function createCrashLogger(logFile: string): (kind: string, err: unknown) => void {
  let busy = false;
  return (kind, err) => {
    if (busy) return; // 打印/写日志过程中又出错：不递归
    busy = true;
    try {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      try {
        console.error(`ClassRep 出现${kind}（已记日志，进程继续运行）：${detail}`);
      } catch {
        // 控制台写不了（管道断了）也继续写文件
      }
      try {
        if (fileSize(logFile) < MAX_LOG_BYTES) {
          mkdirSync(dirname(logFile), { recursive: true });
          appendFileSync(logFile, `[${new Date().toISOString()}] ${kind}：${detail}\n`, 'utf8');
        }
      } catch {
        // 日志写不进去也不能让进程挂掉
      }
    } finally {
      busy = false;
    }
  };
}

/** 挂到 process 上。stdout/stderr 的流错误（EPIPE 等）直接吞掉，不进 uncaughtException。 */
export function installCrashHandlers(logFile: string): void {
  const ignore = (): void => {};
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  const logCrash = createCrashLogger(logFile);
  process.on('uncaughtException', (err) => logCrash('未捕获异常', err));
  process.on('unhandledRejection', (reason) => logCrash('未处理的 Promise 拒绝', reason));
}
