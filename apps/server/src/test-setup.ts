// vitest setupFiles：测试时不读本机 data/llm.json（里面可能有真实 key），改用空的临时目录
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLlmSettingsDir } from './llm-settings.js';

setLlmSettingsDir(mkdtempSync(join(tmpdir(), 'classrep-llm-')));
