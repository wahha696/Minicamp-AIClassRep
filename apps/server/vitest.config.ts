import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    passWithNoTests: true,
    setupFiles: ['src/test-setup.ts'],
    // CI 的 windows-latest 共享机明显慢于开发机且常被安全扫描拖住 I/O；
    // 默认 5s 超时会让本可慢速通过的用例挂掉，放宽并允许 CI 重试一次。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: process.env.CI ? 1 : 0,
  },
});
