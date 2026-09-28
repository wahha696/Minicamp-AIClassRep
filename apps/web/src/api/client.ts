// 前端访问后端的唯一入口。接口格式以 docs/分工/00-总约定.md §7 为准。
// VITE_MOCK=1（`pnpm --filter web dev:mock`）时全部走 mock.ts，不发请求。
import { ApiError } from './error';
import { mockApi } from './mock';
import type {
  AccountsDTO,
  AiSettingsDTO,
  AiTestResultDTO,
  ConnectStatusDTO,
  CsuImportResultDTO,
  CsuImportStartDTO,
  EventDetailDTO,
  EventDTO,
  EventStatus,
  GroupDTO,
  HealthDTO,
  LanSettingsDTO,
  Level,
  LlmProvider,
  LlmSettingsDTO,
  MemoryDTO,
  ScenarioDTO,
  SetupProgressDTO,
  TimetableDTO,
  TodayDTO,
  TodoDTO,
  TodosDTO,
  TrashItemDTO,
} from './types';

export { ApiError };

export interface Api {
  getToday(): Promise<TodayDTO>;
  getEvents(from?: number, to?: number): Promise<EventDTO[]>;
  getEvent(id: number): Promise<EventDetailDTO>;
  /** status 改状态；level 1~4 手动设级（锁），null 交还 AI（解锁） */
  patchEvent(id: number, patch: { status?: EventStatus; level?: Level | null }): Promise<EventDetailDTO>;
  getGroups(): Promise<GroupDTO[]>;
  patchGroup(id: string, patch: { enabled?: boolean; course_name?: string | null }): Promise<GroupDTO>;
  deleteGroupData(id: string): Promise<{ ok: true }>;
  getScenarios(): Promise<ScenarioDTO[]>;
  replay(name: string): Promise<{ injected: number }>;
  resetDemo(): Promise<{ ok: true }>;
  undoReplay(name: string): Promise<{ ok: true }>;
  importText(groupName: string, text: string): Promise<{ messages: number }>;
  getConnectStatus(): Promise<ConnectStatusDTO>;
  /** killQQ=true 只给「关闭电脑版 QQ 并继续」用：会结束用户自己开着的 QQ */
  restartConnect(killQQ?: boolean): Promise<{ ok: true }>;
  /** erase=true：退出并删除本号在本机的全部数据（不可恢复） */
  logoutConnect(erase?: boolean): Promise<{ ok: true }>;
  /** 采集端组件一键下载：POST 立即返回，进度轮询 getFetchNapcatProgress */
  startFetchNapcat(): Promise<{ ok: true }>;
  getFetchNapcatProgress(): Promise<SetupProgressDTO>;
  /** 账号数据管理：列出本机账号库 / 删除指定账号数据 */
  listAccounts(): Promise<AccountsDTO>;
  deleteAccountData(uin: string): Promise<{ ok: true }>;
  /** days=往前补拉多少天（1/7/30），缺省 7 */
  syncNow(days?: 1 | 7 | 30): Promise<{ groups: number; messages: number; failures?: number }>;
  getHealth(): Promise<HealthDTO>;
  getLlmSettings(): Promise<LlmSettingsDTO>;
  saveLlmSettings(provider: LlmProvider, apiKey: string): Promise<LlmSettingsDTO>;
  /** AI 配置（修复计划 3.2）：DeepSeek + Jev 状态；jev_key 传 '' 表示清除 */
  getAiSettings(): Promise<AiSettingsDTO>;
  saveAiSettings(patch: { deepseek_key?: string; jev_key?: string }): Promise<AiSettingsDTO>;
  /** 真实连通性校验；target 省略则两个都测 */
  testAiSettings(target?: 'deepseek' | 'jev'): Promise<AiTestResultDTO>;
  /** 局域网只读（手机访问）：开关状态、手机链接、换 token */
  getLanSettings(): Promise<LanSettingsDTO>;
  setLanEnabled(enabled: boolean): Promise<LanSettingsDTO>;
  rotateLanToken(): Promise<LanSettingsDTO>;
  getTodos(): Promise<TodosDTO>;
  createTodo(todo: { title: string; note?: string; level?: Level }): Promise<TodoDTO>;
  patchTodo(id: number, patch: { title?: string; note?: string; level?: Level; done?: boolean }): Promise<TodoDTO>;
  getTimetable(): Promise<TimetableDTO>;
  saveTimetable(t: TimetableDTO): Promise<TimetableDTO>;
  clearTimetable(): Promise<{ ok: true }>;
  /** 中南教务系统直连导入:第一步拿验证码(内联展示);第二步带验证码拉课次(不落库) */
  csuStartImport(user: string, password: string): Promise<CsuImportStartDTO>;
  csuFetchCourses(sessionId: string, captcha: string): Promise<CsuImportResultDTO>;
  getMemory(): Promise<MemoryDTO>;
  setMemoryEnabled(enabled: boolean): Promise<MemoryDTO>;
  deleteMemoryRule(id: number): Promise<MemoryDTO>;
  clearMemory(): Promise<MemoryDTO>;
  /** 回收站：最近 30 天取消的事件 + 群消息改期前的旧版本，最新的在前 */
  getTrash(): Promise<TrashItemDTO[]>;
  /** 恢复一项（取消 → 回到日历；改期 → 改回旧时间地点），返回最新的回收站列表 */
  restoreTrash(id: string): Promise<TrashItemDTO[]>;
}

export const isMock = import.meta.env.VITE_MOCK === '1';

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), // B14：后端卡住时超时兜底，轮询不会永久停摆
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
  patchEvent: (id, patch) => request('PATCH', `/api/events/${id}`, patch),
  getGroups: () => request('GET', '/api/groups'),
  patchGroup: (id, patch) => request('PATCH', `/api/groups/${encodeURIComponent(id)}`, patch),
  deleteGroupData: (id) => request('DELETE', `/api/groups/${encodeURIComponent(id)}/data`),
  getScenarios: () => request('GET', '/api/demo/scenarios'),
  replay: (name) => request('POST', '/api/demo/replay', { scenario: name }),
  resetDemo: () => request('POST', '/api/demo/reset'),
  undoReplay: (name) => request('POST', '/api/demo/undo', { scenario: name }),
  importText: (groupName, text) => request('POST', '/api/import/text', { groupName, text }),
  getConnectStatus: () => request('GET', '/api/connect/status'),
  restartConnect: (killQQ) => request('POST', '/api/connect/restart', killQQ ? { kill_qq: true } : undefined),
  logoutConnect: (erase) => request('POST', '/api/connect/logout', erase ? { erase: true } : undefined),
  startFetchNapcat: () => request('POST', '/api/setup/fetch-napcat'),
  getFetchNapcatProgress: () => request('GET', '/api/setup/napcat'),
  listAccounts: () => request('GET', '/api/accounts'),
  deleteAccountData: (uin) => request('DELETE', `/api/accounts/${encodeURIComponent(uin)}`),
  // 历史补齐要逐群翻页，几十秒很正常（30 天档可能更久）——10s 默认超时会误报「连不上」
  syncNow: (days) => request('POST', '/api/sync', days === undefined ? undefined : { days }, 180_000),
  getHealth: () => request('GET', '/health'),
  getLlmSettings: () => request('GET', '/api/settings/llm'),
  saveLlmSettings: (provider, apiKey) => request('PUT', '/api/settings/llm', { provider, api_key: apiKey }),
  getAiSettings: () => request('GET', '/api/settings/ai'),
  saveAiSettings: (patch) => request('PUT', '/api/settings/ai', patch),
  testAiSettings: (target) => request('POST', '/api/settings/ai/test', target === undefined ? undefined : { target }),
  getLanSettings: () => request('GET', '/api/settings/lan'),
  setLanEnabled: (enabled) => request('PUT', '/api/settings/lan', { enabled }),
  rotateLanToken: () => request('POST', '/api/settings/lan/rotate'),
  getTodos: () => request('GET', '/api/todos'),
  createTodo: (todo) => request('POST', '/api/todos', todo),
  patchTodo: (id, patch) => request('PATCH', `/api/todos/${id}`, patch),
  getTimetable: () => request('GET', '/api/timetable'),
  saveTimetable: (t) => request('PUT', '/api/timetable', t),
  clearTimetable: () => request('DELETE', '/api/timetable'),
  csuStartImport: (user, password) => request('POST', '/api/timetable/csu/start', { user, password }),
  csuFetchCourses: (sessionId, captcha) =>
    request('POST', '/api/timetable/csu/fetch', { session_id: sessionId, captcha }),
  getMemory: () => request('GET', '/api/settings/memory'),
  setMemoryEnabled: (enabled) => request('PUT', '/api/settings/memory', { enabled }),
  deleteMemoryRule: (id) => request('DELETE', `/api/settings/memory/rules/${id}`),
  clearMemory: () => request('DELETE', '/api/settings/memory'),
  getTrash: () => request('GET', '/api/trash'),
  restoreTrash: (id) => request('POST', `/api/trash/${encodeURIComponent(id)}/restore`),
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
  undoReplay,
  importText,
  getConnectStatus,
  restartConnect,
  logoutConnect,
  startFetchNapcat,
  getFetchNapcatProgress,
  listAccounts,
  deleteAccountData,
  syncNow,
  getHealth,
  getLlmSettings,
  saveLlmSettings,
  getAiSettings,
  saveAiSettings,
  testAiSettings,
  getLanSettings,
  setLanEnabled,
  rotateLanToken,
  getTodos,
  createTodo,
  patchTodo,
  getTimetable,
  saveTimetable,
  clearTimetable,
  csuStartImport,
  csuFetchCourses,
  getMemory,
  setMemoryEnabled,
  deleteMemoryRule,
  clearMemory,
  getTrash,
  restoreTrash,
} = api;

// ===== 直接给 <a href> / <img src> 用的地址（不经 fetch）

export const exportIcsUrl = (from?: number, to?: number) => `/api/export.ics${rangeQuery(from, to)}`;
export const eventIcsUrl = (id: number) => `/api/events/${id}/export.ics`;
export const qrcodeUrl = () => (isMock ? MOCK_QRCODE : `/api/connect/qrcode?t=${Date.now()}`);

// mock 模式没有后端，给连接页一张占位「二维码」看效果
const MOCK_QRCODE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#fff"/>' +
      '<g fill="#0f172a"><rect x="12" y="12" width="56" height="56"/><rect x="132" y="12" width="56" height="56"/><rect x="12" y="132" width="56" height="56"/></g>' +
      '<g fill="#fff"><rect x="22" y="22" width="36" height="36"/><rect x="142" y="22" width="36" height="36"/><rect x="22" y="142" width="36" height="36"/></g>' +
      '<g fill="#0f172a"><rect x="30" y="30" width="20" height="20"/><rect x="150" y="30" width="20" height="20"/><rect x="30" y="150" width="20" height="20"/></g>' +
      '<text x="100" y="108" font-size="16" text-anchor="middle" fill="#64748b">模拟二维码</text></svg>',
  );
