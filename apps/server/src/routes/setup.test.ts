import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteInactiveMock, listAccountsMock, legacyDataExistsMock } = vi.hoisted(() => ({
  deleteInactiveMock: vi.fn(),
  listAccountsMock: vi.fn(),
  legacyDataExistsMock: vi.fn(),
}));

vi.mock('../accounts.js', () => ({
  deleteInactiveAccountData: deleteInactiveMock,
  listAccounts: listAccountsMock,
  legacyDataExists: legacyDataExistsMock,
}));

import { registerSetupRoutes } from './setup.js';

function app(): Hono {
  const result = new Hono();
  registerSetupRoutes(result);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  listAccountsMock.mockReturnValue([]);
  legacyDataExistsMock.mockReturnValue(false);
});

describe('DELETE /api/accounts/:uin', () => {
  it('当前 NapCat 账号返回 409，不会调用会切兜底库的删除逻辑', async () => {
    deleteInactiveMock.mockResolvedValue('active');

    const response = await app().request('/api/accounts/10001', { method: 'DELETE' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '当前 NapCat 登录账号不能直接删除，请使用“退出并删除本号数据”',
    });
    expect(deleteInactiveMock).toHaveBeenCalledOnce();
    expect(deleteInactiveMock).toHaveBeenCalledWith('10001');
  });

  it('非活动账号可删除，不存在时返回 404', async () => {
    deleteInactiveMock.mockResolvedValueOnce('deleted').mockResolvedValueOnce('not_found');

    expect((await app().request('/api/accounts/10002', { method: 'DELETE' })).status).toBe(200);
    expect((await app().request('/api/accounts/10002', { method: 'DELETE' })).status).toBe(404);
  });
});
