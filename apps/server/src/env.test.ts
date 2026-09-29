// B1 验收：.env 逐行解析规则 + env 默认值
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEnv, env, parseEnvFile } from './env.js';
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

  it('D9：` #` 之后算行内注释；紧贴值的 # 与引号内的 # 保留', () => {
    expect(
      parseEnvFile(['A=123 # 这是注释', 'B=123#不是注释', 'C="带 # 号"', "D='也 # 行' # 尾巴"].join('\n')),
    ).toEqual({ A: '123', B: '123#不是注释', C: '带 # 号', D: '也 # 行' });
  });
});

describe('env', () => {
  it('配置键都在，且类型正确', () => {
    expect(Object.keys(env).sort()).toEqual([
      'DEMO_MODE',
      'ENABLE_JEV',
      'FASTJUDGE_MODE',
      'FASTJUDGE_PYTHON',
      'FASTJUDGE_ROOT',
      'FASTJUDGE_ROUTE',
      'JEV_MODEL',
      'JEV_TIMEOUT_MS',
      'LLM_API_KEY',
      'LLM_BASE_URL',
      'LLM_MODEL',
      'LOCAL_JEV_MODEL_PATH',
      'RAW_MSG_TTL_DAYS',
      'TYPESAFE_API_KEY',
    ]);
    expect(typeof env.LLM_BASE_URL).toBe('string');
    expect(typeof env.LLM_API_KEY).toBe('string');
    expect(typeof env.LLM_MODEL).toBe('string');
    expect(typeof env.DEMO_MODE).toBe('boolean');
    expect(typeof env.ENABLE_JEV).toBe('boolean');
    expect(typeof env.TYPESAFE_API_KEY).toBe('string');
    expect(typeof env.RAW_MSG_TTL_DAYS).toBe('number');
  });

  it('默认值：DEMO_MODE=false（B10，要在 .env 里显式开）、RAW_MSG_TTL_DAYS=7（不依赖本机 .env / 环境变量）', () => {
    expect(buildEnv({})).toEqual({
      LLM_BASE_URL: '',
      LLM_API_KEY: '',
      LLM_MODEL: '',
      ENABLE_JEV: true,
      TYPESAFE_API_KEY: '',
      JEV_MODEL: 'jev-latest',
      JEV_TIMEOUT_MS: 3_000,
      FASTJUDGE_MODE: 'jev',
      FASTJUDGE_ROUTE: 'jev',
      LOCAL_JEV_MODEL_PATH: '',
      FASTJUDGE_ROOT: '',
      FASTJUDGE_PYTHON: '',
      DEMO_MODE: false,
      RAW_MSG_TTL_DAYS: 7,
    });
  });

  it('DEMO_MODE 只有 true 才开', () => {
    expect(buildEnv({ DEMO_MODE: 'false' }).DEMO_MODE).toBe(false);
    expect(buildEnv({ DEMO_MODE: 'TRUE1' }).DEMO_MODE).toBe(false);
    expect(buildEnv({ DEMO_MODE: 'true' }).DEMO_MODE).toBe(true);
  });

  it('RAW_MSG_TTL_DAYS：空串 / 0 / 负数 / 非数字回落 7，正数照用', () => {
    for (const bad of ['', '  ', '0', '-3', 'abc']) {
      expect(buildEnv({ RAW_MSG_TTL_DAYS: bad }).RAW_MSG_TTL_DAYS).toBe(7);
    }
    expect(buildEnv({ RAW_MSG_TTL_DAYS: '3' }).RAW_MSG_TTL_DAYS).toBe(3);
  });

  it('.env.example 是合法可解析的样例（键与总约定 §6 一致）', () => {
    const raw = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const parsed = parseEnvFile(raw);
    expect(Object.keys(parsed).sort()).toEqual([
      'DEMO_MODE',
      'ENABLE_JEV',
      'FASTJUDGE_MODE',
      'FASTJUDGE_PYTHON',
      'FASTJUDGE_ROOT',
      'FASTJUDGE_ROUTE',
      'JEV_MODEL',
      'JEV_TIMEOUT_MS',
      'LLM_API_KEY',
      'LLM_BASE_URL',
      'LLM_MODEL',
      'LOCAL_JEV_MODEL_PATH',
      'RAW_MSG_TTL_DAYS',
      'TYPESAFE_API_KEY',
    ]);
    expect(parsed.LLM_API_KEY).toBe('');
  });
});
