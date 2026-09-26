/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' = 用 src/api/mock.ts 的假数据（dev:mock） */
  readonly VITE_MOCK?: string;
}
