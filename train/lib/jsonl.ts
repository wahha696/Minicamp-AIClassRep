// JSONL 读写小工具：追加写、断点续跑（按 key 去重跳过）、统计。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function ensureDirFor(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

/** 读整个 JSONL（坏行跳过并告警） */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const [i, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      console.warn(`[jsonl] ${file} 第 ${i + 1} 行不是合法 JSON，跳过`);
    }
  }
  return out;
}

export class JsonlWriter<T> {
  private readonly seen = new Set<string>();
  written = 0;
  skipped = 0;

  constructor(
    readonly file: string,
    private readonly keyOf: (item: T) => string,
    private readonly extraMeta: Record<string, unknown> = {},
  ) {
    ensureDirFor(file);
    // 断点续跑：载入已写样本的 key，重跑同参数时自动跳过
    for (const item of readJsonl<T>(file)) {
      try {
        this.seen.add(keyOf(item));
      } catch {
        /* keyOf 出错就不去重 */
      }
    }
  }

  write(item: T): boolean {
    const key = this.keyOf(item);
    if (this.seen.has(key)) {
      this.skipped++;
      return false;
    }
    this.seen.add(key);
    appendFileSync(this.file, `${JSON.stringify(item)}\n`, 'utf8');
    this.written++;
    return true;
  }
}
