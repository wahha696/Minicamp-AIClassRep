// 前端访问后端的唯一入口。接口格式以 docs/分工/00-总约定.md §7 为准。
// VITE_MOCK=1（`pnpm --filter web dev:mock`）时全部走 mock.ts，不发请求。
import { ApiError } from './error';
import { mockApi } from './mock';
import type {
  AccountsDTO,
  AccountControlContext,
  AiSettingsDTO,
  AiTestResultDTO,
  ConnectStatusDTO,
  DesktopQQStatusDTO,
  DataBackupStatusDTO,
  CsuImportResultDTO,
  CsuImportStartDTO,
  EventDetailDTO,
  EventDTO,
  EventPatch,
  EventProposalDTO,
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
  getReminderSettings(): Promise<import('../../../../shared/reminders').ReminderSettingsDTO>;
  saveReminderTimes(beforeMinutes: number[], dailyLimit: number): Promise<import('../../../../shared/reminders').ReminderSettingsDTO>;
  getWechatIntake(): Promise<import('../../../../shared/wechat').WechatIntakeDTO>;
  startWechatIntake(input: import('../../../../shared/wechat').WechatIntakeStart): Promise<{ ok: true }>;
  stopWechatIntake(input: import('../../../../shared/wechat').WechatIntakeRequest): Promise<{ ok: true }>;
  /** skipped：该群读取失败已跳过，采集已按保存进度重启，后续请求改用 intake_id */
  refreshWechatHistory(input: import('../../../../shared/wechat').WechatHistoryRequest): Promise<{ inserted: number; has_more: boolean; skipped?: string; intake_id?: string }>;
  getWechatIssues(input: import('../../../../shared/wechat').WechatIntakeRequest & { group_id: string }): Promise<import('../../../../shared/wechat').WechatIssueDTO[]>;
  retryWechatIssues(input: import('../../../../shared/wechat').WechatIntakeRequest & { group_id: string; event_ids: string[] }): Promise<{ ok: true }>;
  getWechatStatus(): Promise<import('../../../../shared/wechat').WechatConnectionDTO>;
  connectWechat(expectedEpoch: string): Promise<{ ok: true }>;
  disconnectWechat(expectedEpoch: string, connectionId: string | null): Promise<{ ok: true }>;
  getWechatGroups(): Promise<import('../../../../shared/wechat').WechatCatalogDTO>;
  refreshWechatGroups(input: import('../../../../shared/wechat').WechatCatalogRefresh): Promise<{ catalog: NonNullable<import('../../../../shared/wechat').WechatCatalogDTO['catalog']>; collecting: false }>;
  selectWechatGroups(input: import('../../../../shared/wechat').WechatGroupChoice): Promise<{ selected_group_ids: string[]; collecting: false }>;
  chooseWorkspace(request: import('../../../../shared/workspaces').WorkspaceChoiceRequest): Promise<{ ok: true }>;
  renameWorkspace(name: string, expectedEpoch: string): Promise<{ ok: true }>;
  resetWorkspaceData(): Promise<{ ok: true }>;
  getToday(): Promise<TodayDTO>;
  getEvents(from?: number, to?: number): Promise<EventDTO[]>;
  getEvent(id: number): Promise<EventDetailDTO>;
  /** 改事件内容、状态或等级；人工修改的业务字段会受到保护。 */
  patchEvent(id: number, patch: EventPatch): Promise<EventDetailDTO>;
  resolveEventProposal(
    eventId: number,
    proposalId: EventProposalDTO['id'],
    decision: 'accept' | 'reject',
    expectedVersion: number,
    expectedUpdatedAt?: number,
  ): Promise<EventDetailDTO>;
  getGroups(): Promise<GroupDTO[]>;
  retryGroup(id: string): Promise<{ accepted: true }>;
  patchGroup(id: string, patch: { enabled?: boolean; course_name?: string | null }): Promise<GroupDTO>;
  deleteGroupData(id: string): Promise<{ ok: true }>;
  getScenarios(): Promise<ScenarioDTO[]>;
  replay(name: string): Promise<{ injected: number }>;
  resetDemo(): Promise<{ ok: true }>;
  undoReplay(name: string): Promise<{ ok: true }>;
  importText(groupName: string, text: string): Promise<{ messages: number }>;
  getConnectStatus(): Promise<ConnectStatusDTO>;
  startDesktopQQ(context: AccountControlContext & { uin: string }): Promise<DesktopQQStatusDTO>;
  returnFromDesktopQQ(context: AccountControlContext & { uin: string }, sessionId: string): Promise<DesktopQQStatusDTO>;
  /** killQQ=true 只给「关闭电脑版 QQ 并继续」用：会结束用户自己开着的 QQ */
  restartConnect(context: AccountControlContext, killQQ?: boolean): Promise<{ ok: true }>;
  /** erase=true：退出并删除本号在本机的全部数据（不可恢复） */
  logoutConnect(context: AccountControlContext & { uin: string }, erase?: boolean): Promise<{ ok: true }>;
  /** 采集端组件一键下载：POST 立即返回，进度轮询 getFetchNapcatProgress */
  startFetchNapcat(): Promise<{ ok: true }>;
  getFetchNapcatProgress(): Promise<SetupProgressDTO>;
  /** 账号数据管理：列出本机账号库 / 删除指定账号数据 */
  listAccounts(): Promise<AccountsDTO>;
  deleteAccountData(uin: string): Promise<{ ok: true }>;
  getDataBackupStatus(): Promise<DataBackupStatusDTO>;
  downloadDataBackup(): Promise<{ blob: Blob; filename: string }>;
  restoreDataBackup(file: File): Promise<{ ok: true; safety_backup_created: true }>;
  downloadDiagnosticReport(): Promise<{ blob: Blob; filename: string }>;
  /** days=往前补拉多少天（1/7/30），缺省 7 */
  syncNow(days?: 1 | 7 | 30): Promise<{ groups: number; messages: number; failures?: number }>;
  getSyncStatus(): Promise<import('./types').SyncGroupStatusDTO[]>;
  getHealth(): Promise<HealthDTO>;
  getLlmSettings(): Promise<LlmSettingsDTO>;
  saveLlmSettings(provider: LlmProvider, apiKey: string): Promise<LlmSettingsDTO>;
  /** AI 配置（修复计划 3.2）：DeepSeek + Jev 状态；jev_key 传 '' 表示清除 */
  getAiSettings(): Promise<AiSettingsDTO>;
  saveAiSettings(patch: { deepseek_key?: string; jev_key?: string; llm?: import('./types').LlmInputDTO }): Promise<AiSettingsDTO>;
  /** 真实连通性校验；target 省略则两个都测 */
  testAiSettings(target?: 'deepseek' | 'jev', candidateKey?: string, candidate?: import('./types').LlmInputDTO): Promise<AiTestResultDTO>;
  /** 局域网只读（手机访问）：开关状态、手机链接、换 token */
  getLanSettings(): Promise<LanSettingsDTO>;
  setLanEnabled(enabled: boolean): Promise<LanSettingsDTO>;
  rotateLanToken(): Promise<LanSettingsDTO>;
  getTodos(): Promise<TodosDTO>;
  createTodo(todo: { title: string; note?: string; level?: Level }): Promise<TodoDTO>;
  patchTodo(id: number, patch: { title?: string; note?: string; level?: Level; done?: boolean }): Promise<TodoDTO>;
  getTimetable(): Promise<TimetableDTO>;
  saveTimetable(t: import('../../../../shared/timetable').TimetableSaveRequest): Promise<TimetableDTO>;
  getTimetableVersions(): Promise<import('../../../../shared/timetable').TimetableVersion[]>;
  restoreTimetable(id:number, revision:number): Promise<TimetableDTO>;
  clearTimetable(expectedRevision?:number): Promise<{ ok: true }>;
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

const ACCOUNT_DATA_PREFIXES = [
  '/api/today',
  '/api/export.ics',
  '/api/events',
  '/api/groups',
  '/api/demo',
  '/api/import',
  '/api/sync',
  '/api/todos',
  '/api/timetable',
  '/api/settings/memory',
  '/api/settings/data',
  '/api/settings/diagnostics',
  '/api/settings/reminders',

  '/api/trash',
  '/api/pet/chat',
] as const;

function isAccountDataPath(path: string): boolean {
  const pathname = path.split('?', 1)[0] ?? path;
  return ACCOUNT_DATA_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** 最近一次连接状态返回的账号库租约。换号后旧页面不会跨号读取或迟到写入。 */
let accountEpoch: string | undefined;
let accountEpochRefresh: Promise<string> | undefined;
let statusRequestSequence = 0;
let publishedStatusSequence = 0;

async function readConnectStatus(): Promise<ConnectStatusDTO> {
  const sequence = ++statusRequestSequence;
  const status = await request<ConnectStatusDTO>('GET', '/api/connect/status');
  if (sequence > publishedStatusSequence) {
    publishedStatusSequence = sequence;
    accountEpoch = status.account_epoch;
  }
  return status;
}

async function ensureAccountEpoch(): Promise<string> {
  if (accountEpoch !== undefined) return accountEpoch;
  if (accountEpochRefresh !== undefined) return accountEpochRefresh;
  accountEpochRefresh = readConnectStatus()
    .then((status) => {
      if (typeof status.account_epoch !== 'string' || status.account_epoch.length === 0) {
        throw new ApiError('连接状态缺少账号上下文，请刷新后重试', 409);
      }
      return accountEpoch ?? status.account_epoch;
    })
    .finally(() => {
      accountEpochRefresh = undefined;
    });
  return accountEpochRefresh;
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  // 本地写接口要求 JSON，包括退出登录、重连等无参数操作。
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  const payload = body === undefined && isWrite ? {} : body;
  let res: Response;
  const scoped = isAccountDataPath(path);
  const epoch = scoped ? await ensureAccountEpoch() : undefined;
  try {
    const headers: Record<string, string> = {};
    // 本机写接口的 CSRF 闸门要求 JSON；即使调用方没有参数也发送空对象。
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (epoch !== undefined) headers['X-ClassRep-Account-Epoch'] = epoch;
    res = await fetch(path, {
      method,
      headers: Object.keys(headers).length === 0 ? undefined : headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs), // B14：后端卡住时超时兜底，轮询不会永久停摆
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError('请求超时，后台可能仍在处理，请稍后查看群状态', 0);
    }
    throw new ApiError('无法连接到 ClassRep，请确认启动窗口没有关闭', 0);
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // 换号或挂库期间的 409 不能让旧 epoch 继续被复用；下一次业务请求会先重取状态。
    // 其他业务冲突（如事件版本过期）即使多取一次状态也是安全的。
    if (scoped && res.status === 409 && accountEpoch === epoch) accountEpoch = undefined;
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `请求失败（${res.status}）`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

/** 为少数需要自行解析 Response 的账号业务请求附加同一个 epoch 闸门。 */
export async function accountScopedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isAccountDataPath(path)) throw new Error(`非账号业务路径不应使用 accountScopedFetch：${path}`);
  const headers = new Headers(init.headers);
  const epoch = await ensureAccountEpoch();
  headers.set('X-ClassRep-Account-Epoch', epoch);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 409 && accountEpoch === epoch) accountEpoch = undefined;
  return response;
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
  getReminderSettings: () => request('GET', '/api/settings/reminders'),
  saveReminderTimes: (before_minutes, daily_limit) => request('PUT', '/api/settings/reminders', { enabled: false, before_minutes, daily_limit, quiet_hours: 'none', missed_policy: 'once_before_deadline' }),
  getWechatIntake: () => request('GET', '/api/connect/wechat/messages/status'),
  startWechatIntake: (body) => request('POST', '/api/connect/wechat/messages/start', body, 180000),
  stopWechatIntake: (body) => request('POST', '/api/connect/wechat/messages/stop', body, 60000),
  // A page can wait behind collection, then read/deliver and recover its worker.
  // Keep the HTTP budget above those server budgets; timing out does not cancel them.
  refreshWechatHistory: (body) => request('POST', '/api/connect/wechat/messages/history', body, 480_000),
  getWechatIssues: (body) => request('POST', '/api/connect/wechat/messages/issues', body, 60000),
  retryWechatIssues: (body) => request('POST', '/api/connect/wechat/messages/retry', body, 60000),
  getWechatStatus: () => request('GET', '/api/connect/wechat/status'),
  connectWechat: (epoch) => request('POST', '/api/connect/wechat/connect', { expected_account_epoch: epoch, approve_identity_read: true }, 60000),
  disconnectWechat: (epoch, connectionId) => request('POST', '/api/connect/wechat/disconnect', { expected_account_epoch: epoch, connection_id: connectionId }, 150000),
  getWechatGroups: () => request('GET', '/api/connect/wechat/groups'),
  refreshWechatGroups: (body) => request('POST', '/api/connect/wechat/groups/refresh', body, 150000),
  selectWechatGroups: (body) => request('POST', '/api/connect/wechat/groups/selection', body, 15000),
  chooseWorkspace: (body) => request('POST', '/api/workspaces/choice', body, 180000),
  renameWorkspace: (name, expectedEpoch) => request('PATCH', '/api/workspaces/name', { name, expected_account_epoch: expectedEpoch }),
  resetWorkspaceData: async () => request('POST', '/api/workspaces/reset-data', {
    expected_account_epoch: await ensureAccountEpoch(), confirm: true,
  }, 180000),
  startDesktopQQ: (context) => request('POST', '/api/connect/desktop-qq', {
    expected_account_epoch: context.accountEpoch, expected_uin: context.uin,
  }),
  returnFromDesktopQQ: (context, sessionId) => request('POST', '/api/connect/desktop-qq/return', {
    expected_account_epoch: context.accountEpoch, expected_uin: context.uin, session_id: sessionId,
  }),
  getToday: () => request('GET', '/api/today'),
  getEvents: (from, to) => request('GET', `/api/events${rangeQuery(from, to)}`),
  getEvent: (id) => request('GET', `/api/events/${id}`),
  patchEvent: (id, patch) => request('PATCH', `/api/events/${id}`, patch),
  resolveEventProposal: (eventId, proposalId, decision, expectedVersion, expectedUpdatedAt) =>
    request('POST', `/api/events/${eventId}/proposals/${proposalId}/resolve`, {
      decision,
      expected_version: expectedVersion,
      expected_updated_at: expectedUpdatedAt,
    }),
  getGroups: () => request('GET', '/api/groups'),
  retryGroup: (id) => request('POST', `/api/groups/${encodeURIComponent(id)}/retry`, {}),
  patchGroup: (id, patch) => request('PATCH', `/api/groups/${encodeURIComponent(id)}`, patch),
  deleteGroupData: (id) => request('DELETE', `/api/groups/${encodeURIComponent(id)}/data`),
  getScenarios: () => request('GET', '/api/demo/scenarios'),
  replay: (name) => request('POST', '/api/demo/replay', { scenario: name }),
  resetDemo: () => request('POST', '/api/demo/reset'),
  undoReplay: (name) => request('POST', '/api/demo/undo', { scenario: name }),
  importText: (groupName, text) => request('POST', '/api/import/text', { groupName, text }),
  getConnectStatus: readConnectStatus,
  restartConnect: (context, killQQ) => request('POST', '/api/connect/restart', {
    expected_account_epoch: context.accountEpoch,
    expected_uin: context.uin,
    ...(killQQ ? { kill_qq: true } : {}),
  }),
  logoutConnect: (context, erase) => request('POST', '/api/connect/logout', {
    expected_account_epoch: context.accountEpoch,
    expected_uin: context.uin,
    ...(erase ? { erase: true } : {}),
  }),
  startFetchNapcat: () => request('POST', '/api/setup/fetch-napcat'),
  getFetchNapcatProgress: () => request('GET', '/api/setup/napcat'),
  listAccounts: () => request('GET', '/api/accounts'),
  deleteAccountData: (uin) => request('DELETE', `/api/accounts/${encodeURIComponent(uin)}`),
  getDataBackupStatus: () => request('GET', '/api/settings/data'),
  downloadDataBackup: async () => {
    const response = await accountScopedFetch('/api/settings/data/backup', {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new ApiError(typeof body?.error === 'string' ? body.error : `备份失败（${response.status}）`, response.status);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'ClassRep.classrep-backup';
    return { blob: await response.blob(), filename };
  },
  restoreDataBackup: async (file) => {
    const response = await accountScopedFetch('/api/settings/data/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => null) as
      | { ok: true; safety_backup_created: true }
      | { error?: unknown }
      | null;
    if (!response.ok || body === null || !('ok' in body)) {
      if (response.status === 409) accountEpoch = undefined;
      throw new ApiError(
        body && 'error' in body && typeof body.error === 'string' ? body.error : `恢复失败（${response.status}）`,
        response.status,
      );
    }
    // 恢复会重新挂载数据库，旧 epoch 必须立即丢弃。
    accountEpoch = undefined;
    return body;
  },
  downloadDiagnosticReport: async () => {
    const response = await accountScopedFetch('/api/settings/diagnostics', {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new ApiError(typeof body?.error === 'string' ? body.error : `诊断导出失败（${response.status}）`, response.status);
    }
    return { blob: await response.blob(), filename: 'ClassRep-diagnostic.json' };
  },
  // 历史补齐要逐群翻页，几十秒很正常（30 天档可能更久）——10s 默认超时会误报「连不上」
  syncNow: (days) => request('POST', '/api/sync', days === undefined ? undefined : { days }, 180_000),
  getSyncStatus: () => request('GET', '/api/sync/status'),
  getHealth: () => request('GET', '/health'),
  getLlmSettings: () => request('GET', '/api/settings/llm'),
  saveLlmSettings: (provider, apiKey) => request('PUT', '/api/settings/llm', { provider, api_key: apiKey }),
  getAiSettings: () => request('GET', '/api/settings/ai'),
  saveAiSettings: (patch) => request('PUT', '/api/settings/ai', patch),
  testAiSettings: (target, candidateKey, candidate) => request('POST', '/api/settings/ai/test', {
    target, ...(candidateKey === undefined ? {} : { candidate_key: candidateKey }), ...(candidate === undefined ? {} : { candidate }),
  }, 25_000),
  getLanSettings: () => request('GET', '/api/settings/lan'),
  setLanEnabled: (enabled) => request('PUT', '/api/settings/lan', { enabled }),
  rotateLanToken: () => request('POST', '/api/settings/lan/rotate'),
  getTodos: () => request('GET', '/api/todos'),
  createTodo: (todo) => request('POST', '/api/todos', todo),
  patchTodo: (id, patch) => request('PATCH', `/api/todos/${id}`, patch),
  getTimetable: () => request('GET', '/api/timetable'),
  saveTimetable: (t) => request('PUT', '/api/timetable', t),
  clearTimetable: (expected_revision) => request('DELETE', '/api/timetable', {expected_revision}),
  getTimetableVersions: () => request('GET', '/api/timetable/versions'),
  restoreTimetable: (id, revision) => request('POST', `/api/timetable/restore/${id}`, {expected_revision:revision}),
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
  getReminderSettings, saveReminderTimes,
  getWechatIntake, startWechatIntake, stopWechatIntake, refreshWechatHistory, getWechatIssues, retryWechatIssues,
  getWechatStatus,
  connectWechat,
  disconnectWechat,
  getWechatGroups,
  refreshWechatGroups,
  selectWechatGroups,
  chooseWorkspace,
  renameWorkspace,
  resetWorkspaceData,
  getToday,
  getEvents,
  getEvent,
  patchEvent,
  resolveEventProposal,
  getGroups,
  retryGroup,
  patchGroup,
  deleteGroupData,
  getScenarios,
  replay,
  resetDemo,
  undoReplay,
  importText,
  getConnectStatus,
  startDesktopQQ,
  returnFromDesktopQQ,
  restartConnect,
  logoutConnect,
  startFetchNapcat,
  getFetchNapcatProgress,
  listAccounts,
  deleteAccountData,
  getDataBackupStatus,
  downloadDataBackup,
  restoreDataBackup,
  downloadDiagnosticReport,
  syncNow,
  getSyncStatus,
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
  getTimetableVersions,
  restoreTimetable,
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

function accountDownloadUrl(path: string): string {
  // epoch 不是身份凭据，只是当前库的短生命期标识。<a> 无法加请求头，因此 GET 下载用 query。
  if (isMock || accountEpoch === undefined) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}account_epoch=${encodeURIComponent(accountEpoch)}`;
}

export const exportIcsUrl = (from?: number, to?: number) => accountDownloadUrl(`/api/export.ics${rangeQuery(from, to)}`);
export const eventIcsUrl = (id: number) => accountDownloadUrl(`/api/events/${id}/export.ics`);
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
