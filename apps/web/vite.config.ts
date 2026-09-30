import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
  test: {
    // CI 的 windows-latest 共享机明显慢于开发机；mock 用例用真实 delay 串行，
    // 默认 5s 超时在慢机上会挂，放宽并允许 CI 重试一次。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: process.env.CI ? 1 : 0,
  },
});
