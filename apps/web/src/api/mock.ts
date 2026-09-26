// VITE_MOCK=1 时 client.ts 用这里的假数据代替后端，用于后端没好时开发页面。
// 数据存在内存里：PATCH/删除/回放都会改变后续返回，刷新页面恢复初始状态。
// 连接状态可在浏览器控制台切换，方便调 D1 黄条 / D5 连接页：
//   localStorage.mockConnectState = 'waiting_qr'   // 任一 ConnectState，默认 online
//   localStorage.mockFirstRun = '1'                // 模拟首次使用（守卫拦到 /connect）
import type { Api } from './client';
import { ApiError } from './error';
import type {
  ConnectState,
  ConnectStatusDTO,
  EventDetailDTO,
  EventDTO,
  GroupDTO,
  HealthDTO,
  LlmSettingsDTO,
  HistoryDTO,
  ScenarioDTO,
  SourceMessageDTO,
  TodayDTO,
} from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SHANGHAI_OFFSET = 8 * HOUR;

const bootAt = Date.now();

/** 上海时间「今天 + dayOffset 天」的 hh:mm，毫秒时间戳 */
function at(dayOffset: number, h: number, m = 0): number {
  const todayStart = Math.floor((Date.now() + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
  return todayStart + dayOffset * DAY + h * HOUR + m * MIN;
}

function shanghaiDate(ts: number): string {
  return new Date(ts + SHANGHAI_OFFSET).toISOString().slice(0, 10);
}

function hhmm(ts: number): string {
  return new Date(ts + SHANGHAI_OFFSET).toISOString().slice(11, 16);
}

// ===== 初始数据

const groups: (Omit<GroupDTO, 'event_count'>)[] = [
  { group_id: 'demo-math', name: '高数(2)班', enabled: true, message_count: 126 },
  { group_id: 'demo-linear', name: '线性代数课程群', enabled: true, message_count: 58 },
  { group_id: 'demo-class', name: '计科2301班级群', enabled: true, message_count: 342 },
  { group_id: 'demo-club', name: '摄影社', enabled: false, message_count: 17 },
];

type MockEvent = Omit<EventDTO, 'group_name'> & {
  sources: SourceMessageDTO[];
  history: HistoryDTO[];
};

function makeEvent(
  e: Pick<EventDTO, 'id' | 'group_id' | 'type' | 'title'> & Partial<MockEvent>,
): MockEvent {
  const created = e.created_at ?? bootAt - 3 * HOUR;
  return {
    description: '',
    start_at: null,
    end_at: null,
    deadline_at: null,
    location: null,
    action_required: null,
    status: 'active',
    confidence: 0.9,
    version: 1,
    created_at: created,
    updated_at: created,
    sources: [],
    history: [],
    ...e,
  };
}

let events: MockEvent[] = [
  // 改期场景：2 条来源 + 1 条变更记录
  makeEvent({
    id: 1,
    group_id: 'demo-math',
    type: 'exam',
    title: '高数随堂小测',
    description: '第三章导数与微分，闭卷',
    start_at: at(0, 14),
    end_at: at(0, 14, 45),
    location: 'A203',
    action_required: '带计算器',
    confidence: 0.93,
    version: 2,
    created_at: bootAt - 3 * HOUR,
    updated_at: bootAt - 5 * MIN,
    sources: [
      {
        message_id: 'demo-reschedule-0',
        sender_name: '张老师',
        text: '@全体成员 后天下午两点在 A301 随堂小测，带计算器',
        sent_at: bootAt - 3 * HOUR,
      },
      {
        message_id: 'demo-reschedule-2',
        sender_name: '班长',
        text: '[at] 小测改到今天下午两点，教室改 A203',
        sent_at: bootAt - 5 * MIN,
      },
    ],
    history: [
      {
        version: 2,
        changed_fields: {
          start_at: { from: at(2, 14), to: at(0, 14) },
          end_at: { from: at(2, 14, 45), to: at(0, 14, 45) },
          location: { from: 'A301', to: 'A203' },
        },
        source_message_id: 'demo-reschedule-2',
        changed_at: bootAt - 5 * MIN,
      },
    ],
  }),
  makeEvent({
    id: 2,
    group_id: 'demo-linear',
    type: 'assignment',
    title: '线代第三章习题',
    description: 'P87 第 1~12 题，拍照上传学习通',
    deadline_at: at(0, 23, 59),
    action_required: '上传学习通',
    confidence: 0.88,
    sources: [
      {
        message_id: 'demo-linear-3',
        sender_name: '李助教',
        text: '第三章习题 P87 1~12 今晚 23:59 前拍照交学习通',
        sent_at: at(-1, 20, 12),
      },
    ],
  }),
  makeEvent({
    id: 3,
    group_id: 'demo-class',
    type: 'assignment',
    title: '英语作文初稿',
    deadline_at: at(0, 12),
    status: 'done',
    confidence: 0.81,
  }),
  makeEvent({
    id: 4,
    group_id: 'demo-class',
    type: 'meeting',
    title: '班委例会',
    start_at: at(1, 19),
    end_at: at(1, 20),
    location: '教学楼 B105',
    confidence: 0.9,
    sources: [
      {
        message_id: 'demo-class-8',
        sender_name: '班长',
        text: '明晚 7 点 B105 班委例会，各位班委准时到',
        sent_at: bootAt - 2 * HOUR,
      },
    ],
  }),
  makeEvent({
    id: 5,
    group_id: 'demo-club',
    type: 'activity',
    title: '摄影社招新宣讲',
    start_at: at(3, 18, 30),
    location: '学生活动中心 201',
    status: 'pending_confirm',
    confidence: 0.55,
  }),
  makeEvent({
    id: 6,
    group_id: 'demo-math',
    type: 'exam',
    title: '高数期中考试',
    start_at: at(5, 9),
    end_at: at(5, 11),
    location: '主楼 305',
    action_required: '带学生证、2B 铅笔',
    confidence: 0.96,
  }),
  makeEvent({
    id: 7,
    group_id: 'demo-class',
    type: 'announcement',
    title: '期中考试安排已发布',
    description: '详见教务处网站通知',
    confidence: 0.72,
  }),
  makeEvent({
    id: 8,
    group_id: 'demo-class',
    type: 'other',
    title: '周末班级聚餐',
    start_at: at(2, 18),
    status: 'cancelled',
    confidence: 0.8,
  }),
];

const scenarios: ScenarioDTO[] = [
  { name: 'reschedule', title: '改期场景', count: 3 },
  { name: 'noisy-class', title: '班级群日常（大量闲聊）', count: 40 },
];

let filteredCount = 214;
let llmCalledCount = 37;

// ===== 工具

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(structuredClone(value)), 150 + Math.random() * 150),
  );
}

function fail(message: string, status: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new ApiError(message, status)), 150));
}

function toDTO(e: MockEvent): EventDTO {
  const dto: EventDTO & Partial<MockEvent> = { ...e, group_name: '' };
  delete dto.sources;
  delete dto.history;
  dto.group_name = groups.find((g) => g.group_id === e.group_id)?.name ?? e.group_id;
  return dto;
}

/** 排序用的时间：有开始时间用开始时间，否则用截止时间 */
function timeOf(e: EventDTO): number {
  return e.start_at ?? e.deadline_at ?? Number.MAX_SAFE_INTEGER;
}

function inRange(ts: number | null, from: number, to: number): boolean {
  return ts !== null && ts >= from && ts < to;
}

function connectState(): ConnectState {
  return (localStorage.getItem('mockConnectState') as ConnectState | null) ?? 'online';
}

// ===== 实现

export const mockApi: Api = {
  getToday() {
    const from = at(0, 0);
    const to = at(1, 0);
    const list = events
      .filter((e) => e.status !== 'cancelled')
      .filter((e) => inRange(e.start_at, from, to) || inRange(e.deadline_at, from, to))
      .map(toDTO)
      .sort((a, b) => timeOf(a) - timeOf(b));

    const todo = list.filter((e) => e.status !== 'done');
    const urgent = todo.find((e) => timeOf(e) >= Date.now()) ?? todo[0];
    const summary = urgent
      ? `今天 ${list.length} 件事，最急的是 ${hhmm(timeOf(urgent))} ${urgent.title}`
      : '今天没有待办，轻松一天';

    const today: TodayDTO = { date: shanghaiDate(Date.now()), summary, events: list };
    return delay(today);
  },

  getEvents(from, to) {
    let list = events;
    if (from === undefined && to === undefined) {
      list = list.filter((e) => e.status !== 'cancelled');
    } else {
      const f = from ?? -Infinity;
      const t = to ?? Infinity;
      list = list.filter((e) => inRange(e.start_at, f, t) || inRange(e.deadline_at, f, t));
    }
    return delay(list.map(toDTO).sort((a, b) => timeOf(a) - timeOf(b)));
  },

  getEvent(id) {
    const e = events.find((x) => x.id === id);
    if (!e) return fail('事件不存在', 404);
    const detail: EventDetailDTO = { ...toDTO(e), sources: e.sources, history: e.history };
    return delay(detail);
  },

  patchEvent(id, status) {
    const e = events.find((x) => x.id === id);
    if (!e) return fail('事件不存在', 404);
    e.status = status;
    e.updated_at = Date.now();
    return delay(toDTO(e));
  },

  getGroups() {
    return delay(
      groups.map((g) => ({ ...g, event_count: events.filter((e) => e.group_id === g.group_id).length })),
    );
  },

  patchGroup(id, enabled) {
    const g = groups.find((x) => x.group_id === id);
    if (!g) return fail('群不存在', 404);
    g.enabled = enabled;
    return delay({ ...g, event_count: events.filter((e) => e.group_id === id).length });
  },

  deleteGroupData(id) {
    const g = groups.find((x) => x.group_id === id);
    if (!g) return fail('群不存在', 404);
    g.message_count = 0;
    events = events.filter((e) => e.group_id !== id);
    return delay({ ok: true as const });
  },

  getScenarios() {
    return delay(scenarios);
  },

  replay(name) {
    const s = scenarios.find((x) => x.name === name);
    if (!s) return fail(`没有名为 ${name} 的剧本`, 404);
    filteredCount += Math.floor(s.count * 0.6);
    llmCalledCount += 1;
    return delay({ injected: s.count });
  },

  resetDemo() {
    events = events.filter((e) => !e.group_id.startsWith('demo-'));
    groups.splice(0, groups.length, ...groups.filter((g) => !g.group_id.startsWith('demo-')));
    return delay({ ok: true as const });
  },

  importText(groupName, text) {
    if (!groupName.trim() || !text.trim()) return fail('群名和聊天记录都不能为空', 400);
    return delay({ messages: text.split('\n').filter((l) => l.trim()).length });
  },

  getConnectStatus() {
    const state = connectState();
    const status: ConnectStatusDTO = {
      state,
      since: bootAt,
      first_run: localStorage.getItem('mockFirstRun') === '1',
      ...(state === 'online' ? { uin: '10001' } : {}),
      ...(state === 'error'
        ? { message: '采集端异常。常见原因是 QQ 版本过旧，请更新到最新版 QQ 后重试' }
        : {}),
    };
    return delay(status);
  },

  restartConnect() {
    localStorage.removeItem('mockConnectState');
    return delay({ ok: true as const });
  },

  syncNow() {
    if (connectState() !== 'online') return fail('QQ 未连接', 409);
    return delay({ groups: groups.filter((g) => g.enabled).length, messages: 12 });
  },

  getHealth() {
    const qq = connectState();
    const health: HealthDTO = {
      status: qq === 'online' ? 'ok' : 'degraded',
      db: 'ok',
      qq,
      llm: 'ok',
      jev: 'disabled',
      filtered_count: filteredCount,
      llm_called_count: llmCalledCount,
      uptime: Math.floor((Date.now() - bootAt) / 1000),
    };
    return delay(health);
  },

  getLlmSettings() {
    return delay({ ...mockLlm });
  },

  saveLlmSettings(provider, apiKey) {
    const key = apiKey.trim();
    if (!key) return fail('API Key 不能为空', 400);
    if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) return fail('API Key 格式不对，应以 sk- 开头', 400);
    mockLlm = { provider, configured: true, key_hint: `${key.slice(0, 3)}****${key.slice(-4)}`, source: 'web' };
    return delay({ ...mockLlm });
  },
};

let mockLlm: LlmSettingsDTO = { provider: 'deepseek', configured: false, key_hint: '', source: 'none' };
