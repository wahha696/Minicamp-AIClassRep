// Node 原生 TS 直跑的辅助钩子（仅本地/CI 冒烟验证用，不属于业务代码）：
// 源码里的相对导入写的是 './x.js'（tsc NodeNext 风格），Node strip-types 需要把
// 同名 .ts 映射过去才能加载。用法：
//   node --experimental-strip-types --import ./verify/hooks.mjs verify/verify-accounts.ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const parent = context.parentURL;
      if (
        err?.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.endsWith('.js') &&
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        parent !== undefined
      ) {
        const tsUrl = new URL(specifier.slice(0, -3) + '.ts', parent).href;
        if (existsSync(fileURLToPath(tsUrl))) {
          return { url: tsUrl, shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
