// 前端访问后端的唯一入口。接口格式以 docs/分工/00-总约定.md §7 为准。
// VITE_MOCK=1（`pnpm --filter web dev:mock`）时全部走 mock.ts，不发请求。
import { ApiError } from './error';
import { mockApi } from './mock';
import type {
  ConnectStatusDTO,
  EventDetailDTO,
  EventDTO,
  EventStatus,
  GroupDTO,
  HealthDTO,
  ScenarioDTO,
  TodayDTO,
} from './types';

export { ApiError };

export interface Api {
  getToday(): Promise<TodayDTO>;
  getEvents(from?: number, to?: number): Promise<EventDTO[]>;
  getEvent(id: number): Promise<EventDetailDTO>;
  patchEvent(id: number, status: EventStatus): Promise<EventDTO>;
  getGroups(): Promise<GroupDTO[]>;
  patchGroup(id: string, enabled: boolean): Promise<GroupDTO>;
  deleteGroupData(id: string): Promise<{ ok: true }>;
  getScenarios(): Promise<ScenarioDTO[]>;
  replay(name: string): Promise<{ injected: number }>;
  resetDemo(): Promise<{ ok: true }>;
  importText(groupName: string, text: string): Promise<{ messages: number }>;
  getConnectStatus(): Promise<ConnectStatusDTO>;
  restartConnect(): Promise<{ ok: true }>;
  syncNow(): Promise<{ groups: number; messages: number }>;
  getHealth(): Promise<HealthDTO>;
}

export const isMock = import.meta.env.VITE_MOCK === '1';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接到 ClassRep，请确认启动窗口没有关闭', 0);
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `请求失败（${res.status}）`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

/** 拼 `?from=&to=`，省略的参数不出现 */
function rangeQuery(from?: number, to?: number): string {
  const q = new URLSearchParams();
  if (from !== undefined) q.set('from', String(from));
  if (to !== undefined) q.set('to', String(to));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const realApi: Api = {
  getToday: () => request('GET', '/api/today'),
  getEvents: (from, to) => request('GET', `/api/events${rangeQuery(from, to)}`),
  getEvent: (id) => request('GET', `/api/events/${id}`),
  patchEvent: (id, status) => request('PATCH', `/api/events/${id}`, { status }),
  getGroups: () => request('GET', '/api/groups'),
  patchGroup: (id, enabled) => request('PATCH', `/api/groups/${encodeURIComponent(id)}`, { enabled }),
  deleteGroupData: (id) => request('DELETE', `/api/groups/${encodeURIComponent(id)}/data`),
  getScenarios: () => request('GET', '/api/demo/scenarios'),
  replay: (name) => request('POST', '/api/demo/replay', { scenario: name }),
  resetDemo: () => request('POST', '/api/demo/reset'),
  importText: (groupName, text) => request('POST', '/api/import/text', { groupName, text }),
  getConnectStatus: () => request('GET', '/api/connect/status'),
  restartConnect: () => request('POST', '/api/connect/restart'),
  syncNow: () => request('POST', '/api/sync'),
  getHealth: () => request('GET', '/health'),
};

const api: Api = isMock ? mockApi : realApi;

export const {
  getToday,
  getEvents,
  getEvent,
  patchEvent,
  getGroups,
  patchGroup,
  deleteGroupData,
  getScenarios,
  replay,
  resetDemo,
  importText,
  getConnectStatus,
  restartConnect,
  syncNow,
  getHealth,
} = api;

// ===== 直接给 <a href> / <img src> 用的地址（不经 fetch）

export const exportIcsUrl = (from?: number, to?: number) => `/api/export.ics${rangeQuery(from, to)}`;
export const eventIcsUrl = (id: number) => `/api/events/${id}/export.ics`;
export const qrcodeUrl = () => `/api/connect/qrcode?t=${Date.now()}`;
