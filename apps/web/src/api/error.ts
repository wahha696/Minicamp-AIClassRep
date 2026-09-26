/** 接口出错时抛出。message 就是后端返回的 `error` 字段（给人看的中文），status 供页面区分 403/409 等 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
