// 更新检查的纯函数用例（S05）：版本比较 + 下载包 SHA-256 校验。
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isNewer, sha256File } from './update-check.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('isNewer', () => {
  it.each([
    ['v1.2.10', '1.2.9', true],
    ['1.3.0', '1.2.99', true],
    ['v1.2.3', '1.2.3', false], // 同版本不更新
    ['1.2.3', '1.2.4', false], // 老于当前不更新
    ['', '1.0.0', false],
    ['v2', '1.9.9', true],
  ] as const)('%s vs %s → %s', (latest, current, want) => {
    expect(isNewer(latest, current)).toBe(want);
  });
});

describe('sha256File（S05 完整性校验）', () => {
  it('文件内容 → sha256 摘要；与 createHash 一致、篡改可检出', async () => {
    const d = mkdtempSync(join(tmpdir(), 'classrep-upd-'));
    dirs.push(d);
    const f = join(d, 'pkg.bin');
    writeFileSync(f, 'ClassRep zip payload v1.2.3');
    const want = createHash('sha256').update('ClassRep zip payload v1.2.3').digest('hex');
    expect(await sha256File(f)).toBe(want);
    // 内容变一个字节 → 摘要必然不同（更新前对不上清单就丢弃）
    writeFileSync(f, 'ClassRep zip payload v1.2.4');
    expect(await sha256File(f)).not.toBe(want);
  });
});
