// B1 验收：.env 逐行解析规则 + env 默认值
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { env, parseEnvFile } from './env.js';
import { ROOT } from './paths.js';

describe('parseEnvFile', () => {
  it('解析 KEY=VALUE，忽略空行和 # 开头的注释', () => {
    const raw = [
      '# 这是注释',
      '',
      'LLM_MODEL=deepseek-chat',
      '   ',
      '  LLM_BASE_URL = https://api.deepseek.com/v1  ',
      '# LLM_API_KEY=不该被读到',
    ].join('\n');
    expect(parseEnvFile(raw)).toEqual({
      LLM_MODEL: 'deepseek-chat',
      LLM_BASE_URL: 'https://api.deepseek.com/v1',
    });
  });

  it('去掉值两端配对的引号', () => {
    expect(parseEnvFile('A="带 空格"\nB=\'x\'\nC="不配对\n')).toEqual({
      A: '带 空格',
      B: 'x',
      C: '"不配对',
    });
  });

  it('没有 = 的行、键为空的行都忽略；值里可以有 =', () => {
    expect(parseEnvFile('没有等号\n=只有值\nTOKEN=a=b=c\n')).toEqual({ TOKEN: 'a=b=c' });
  });

  it('空值解析成空字符串', () => {
    expect(parseEnvFile('LLM_API_KEY=\n')).toEqual({ LLM_API_KEY: '' });
  });
});

describe('env', () => {
  it('五个键都在，且类型正确', () => {
    expect(Object.keys(env).sort()).toEqual([
      'DEMO_MODE',
      'LLM_API_KEY',
      'LLM_BASE_URL',
      'LLM_MODEL',
      'RAW_MSG_TTL_DAYS',
    ]);
    expect(typeof env.LLM_BASE_URL).toBe('string');
    expect(typeof env.LLM_API_KEY).toBe('string');
    expect(typeof env.LLM_MODEL).toBe('string');
    expect(typeof env.DEMO_MODE).toBe('boolean');
    expect(typeof env.RAW_MSG_TTL_DAYS).toBe('number');
  });

  it('默认值：DEMO_MODE=true、RAW_MSG_TTL_DAYS=7', () => {
    // 仓库里没有 .env（只有 .env.example），也没有对应的真实环境变量
    expect(env.DEMO_MODE).toBe(true);
    expect(env.RAW_MSG_TTL_DAYS).toBe(7);
  });

  it('.env.example 是合法可解析的样例（键与总约定 §6 一致）', () => {
    const raw = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const parsed = parseEnvFile(raw);
    expect(Object.keys(parsed).sort()).toEqual([
      'DEMO_MODE',
      'LLM_API_KEY',
      'LLM_BASE_URL',
      'LLM_MODEL',
      'RAW_MSG_TTL_DAYS',
    ]);
    expect(parsed.LLM_API_KEY).toBe('');
  });
});
