// 临时验证:真实 writeNapcatConfig 生成的 loadNapCat.js 在 CJS 与 ESM 两种解析下都能跑通
// (QQ 的 package.json 无 type:module → CJS;确认无 import.meta、无 await-in-non-async 之类语法坑)
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeNapcatConfig } from './config.js';

describe('生成的 loadNapCat.js 语法与行为(临时)', () => {
  it('CJS 与 ESM 解析都执行成功且 argv 注入生效', () => {
    const napcatDir = mkdtempSync(join(tmpdir(), 'ldchk-'));
    try {
      writeNapcatConfig(napcatDir);
      let src = readFileSync(join(napcatDir, 'loadNapCat.js'), 'utf8');
      const stub = 'console.log("ARGV_SEEN=" + JSON.stringify(process.argv.slice(1)))';
      src = src.replace(/await import\("file:[^"]+"\)/, stub);
      expect(src).not.toContain('import.meta');
      expect(src).not.toContain('_loader_debug'); // 调试日志已去掉（修复计划 D5）

      const cjs = join(napcatDir, 'probe.cjs');
      const esm = join(napcatDir, 'probe.mjs');
      // 桩:加载器按 <napcatDir>/../data/settings.json 找账号,给一个真实文件
      mkdirSync(join(napcatDir, '..', 'data'), { recursive: true });
      writeFileSync(join(napcatDir, '..', 'data', 'settings.json'), '{"uin":"2580544509"}', 'utf8');
      writeFileSync(cjs, src, 'utf8');
      writeFileSync(esm, src, 'utf8');
      for (const [tag, file] of [['CJS', cjs], ['ESM', esm]] as const) {
        const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
        console.log(`[${tag}] exit=${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        expect(r.status, `${tag} 应能解析并执行`).toBe(0);
        expect(r.stdout).toContain('-q');
      }

    } finally {
      rmSync(napcatDir, { recursive: true, force: true });
    }
  });
});
