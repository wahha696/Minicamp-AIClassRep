// 历史补齐（FR-2）。主人是 A，实现见 apps/server/src/napcat/ 那一侧。
// 这里按 00-总约定 §6 的签名给一个能编译的空实现，index.ts 不调用它。

/** 补齐离线期间的消息；未连接时返回 0/0 */
export async function syncHistory(): Promise<{ groups: number; messages: number }> {
  return { groups: 0, messages: 0 };
}
