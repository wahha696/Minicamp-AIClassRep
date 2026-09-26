// OneBot WS 客户端：事件 → 统一 Message → ingest；echo 调 action。主人是 A。
// B0 只给能编译的空实现：未连接时 reject。

/** 未连接时 reject（架构.md §5：action 全走 WS 的 echo 匹配回包） */
export function callAction<T = unknown>(
  _action: string,
  _params: object,
  _timeoutMs?: number,
): Promise<T> {
  return Promise.reject(new Error('QQ 未连接'));
}
