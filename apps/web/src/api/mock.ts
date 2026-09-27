// VITE_MOCK=1 时 client.ts 用这里的假数据代替后端，用于后端没好时开发页面。
// 数据存在内存里：PATCH/删除/回放都会改变后续返回，刷新页面恢复初始状态。
// 连接状态可在浏览器控制台切换，方便调 D1 黄条 / D5 连接页：
//   localStorage.mockConnectState = 'waiting_qr'   // 任一 ConnectState，默认 online
//   localStorage.mockFirstRun = '1'                // 模拟首次使用（守卫拦到 /connect）
import type { Api } from './client';
import { ApiError } from './error';
import { isTodo } from '../lib/todo';
import type {
  AccountsDTO,
  ConnectState,
  ConnectStatusDTO,
  CourseDTO,
  EventDetailDTO,
  EventDTO,
  EventStatus,
  GroupDTO,
  HealthDTO,
  Level,
  LlmSettingsDTO,
  HistoryDTO,
  MemoryDTO,
  ScenarioDTO,
  SetupProgressDTO,
  SourceMessageDTO,
  TimetableDTO,
  TodayDTO,
  TodoDTO,
  TodosDTO,
  TrashItemDTO,
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
  { group_id: 'demo-math', name: '高数(2)班', enabled: true, message_count: 126, course_name: '概率论与数理统计A' },
  { group_id: 'demo-linear', name: '线性代数课程群', enabled: true, message_count: 58, course_name: null },
  { group_id: 'demo-class', name: '计科2301班级群', enabled: true, message_count: 342, course_name: null },
  { group_id: 'demo-club', name: '摄影社', enabled: false, message_count: 17, course_name: null },
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
    level: 2,
    level_locked: false,
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
    level: 4,
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
    level: 4,
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
    level: 3,
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
    level: 3,
    level_locked: true, // 演示「手动锁定」的图钉
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
    level: 1,
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
    level: 3,
  }),
  makeEvent({
    id: 7,
    group_id: 'demo-class',
    type: 'announcement',
    title: '期中考试安排已发布',
    description: '详见教务处网站通知',
    confidence: 0.72,
    level: 1,
  }),
  makeEvent({
    id: 8,
    group_id: 'demo-class',
    type: 'other',
    title: '周末班级聚餐',
    start_at: at(2, 18),
    location: '二食堂三楼',
    status: 'cancelled',
    confidence: 0.8,
    level: 1,
    version: 2,
    updated_at: bootAt - 40 * MIN,
    sources: [
      {
        message_id: 'demo-class-12',
        sender_name: '班长',
        text: '周末聚餐先取消了，等期中考完再约',
        sent_at: bootAt - 40 * MIN,
      },
    ],
    history: [
      {
        version: 2,
        changed_fields: { status: { from: 'active', to: 'cancelled' } },
        source_message_id: 'demo-class-12',
        changed_at: bootAt - 40 * MIN,
      },
    ],
  }),
  // ===== 待办类事件（没有截止，不进 today/events/ics，出现在待办框里）
  makeEvent({
    id: 9,
    group_id: 'demo-class',
    type: 'assignment',
    title: '开始准备课程设计选题',
    description: '先想好做哪个方向，分组名单下周交',
    start_at: at(1, 10),
    confidence: 0.83,
    level: 3,
  }),
  makeEvent({
    id: 10,
    group_id: 'demo-linear',
    type: 'announcement',
    title: '线性代数下周换教室',
    description: '下周起改到 B 座 210 上课',
    confidence: 0.77,
    level: 1,
  }),
];

// ===== 手动待办 / 课表 / 长期记忆（mock 也走内存） =====

let todos: TodoDTO[] = [
  { id: 1, title: '把学生证充磁', note: '一食堂一楼自助机', level: 2, done_at: null, created_at: bootAt - DAY },
];
let nextTodoId = 2;

// 与 docs/拓展功能-开发计划.md 附录 A 一致的解析结果（13 个课次）
const mockTimetable: TimetableDTO = {
  semester_start: '2026-09-07',
  courses: [
    { name: '创新创业导论', teacher: '王斌(教授),钟萍(副教授),张永敏(教授),杨柳(教授)', location: 'B座508', weekday: 1, block: 3, weeks: range(1, 16) },
    { name: '大学物理B（二）(信息类)', teacher: '郑小娟(教授)', location: 'A座404', weekday: 1, block: 4, weeks: range(3, 18) },
    { name: '概率论与数理统计A', teacher: '彭丽华(副教授)', location: 'B座312', weekday: 2, block: 2, weeks: range(3, 16) },
    { name: '体育（三）', teacher: '张绮(讲师)', location: '', weekday: 2, block: 3, weeks: range(3, 18) },
    { name: '计算机组成原理与体系结构', teacher: '郭菲(教授)', location: 'B座519', weekday: 2, block: 4, weeks: range(1, 16) },
    { name: '面向对象编程（C++）', teacher: '杨希(讲师)', location: 'B座507', weekday: 3, block: 2, weeks: range(1, 16) },
    { name: '形势与政策', teacher: '史建权(高级政工师)', location: 'C座410', weekday: 3, block: 5, weeks: [8, 12] },
    { name: '概率论与数理统计A', teacher: '彭丽华(副教授)', location: 'B座312', weekday: 4, block: 2, weeks: range(3, 16) },
    { name: '中国近现代史纲要', teacher: '罗春梅(副教授)', location: 'B座219', weekday: 4, block: 3, weeks: range(3, 18) },
    { name: '计算机组成原理与体系结构', teacher: '郭菲(教授)', location: 'B座519', weekday: 4, block: 4, weeks: range(1, 16) },
    { name: '传统文化与管理智慧', teacher: '戴国斌(副教授)', location: 'C座104', weekday: 4, block: 5, weeks: range(3, 18) },
    { name: '人工智能', teacher: '钟萍(副教授)', location: 'B座505', weekday: 5, block: 3, weeks: range(1, 16) },
    { name: '大学物理B（二）(信息类)', teacher: '郑小娟(教授)', location: 'A座404', weekday: 5, block: 4, weeks: range(3, 18) },
  ],
};

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

let memory: { enabled: boolean; rules: { id: number; text: string; level: Level }[]; feedback_count: number } = {
  enabled: true,
  rules: [
    { id: 1, text: '实验报告一律 → 4 紧急', level: 4 },
    { id: 2, text: '社团活动一律 → 1 低', level: 1 },
  ],
  feedback_count: 5,
};

const scenarios: ScenarioDTO[] = [
  { name: 'reschedule', title: '改期场景', count: 3, group_id: 'demo-math', active: false },
  { name: 'noisy-class', title: '班级群日常（大量闲聊）', count: 40, group_id: 'demo-noisy', active: false },
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
      .filter((e) => e.status !== 'cancelled' && !isTodo(e))
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
    // 与后端一致：cancelled 与待办类事件都不返回（范围查询也一样）
    let list = events.filter((e) => e.status !== 'cancelled' && !isTodo(e));
    if (from !== undefined || to !== undefined) {
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

  patchEvent(id, patch) {
    const e = events.find((x) => x.id === id);
    if (!e) return fail('事件不存在', 404);
    if (patch.status !== undefined && patch.status !== e.status) {
      // 与后端一致：手动改状态也写一条 history（不升 version），回收站靠它认出「你取消的」
      e.history = [
        ...e.history,
        {
          version: e.version,
          changed_fields: { status: { from: e.status, to: patch.status } },
          source_message_id: null,
          changed_at: Date.now(),
        },
      ];
      e.status = patch.status;
    }
    if (patch.level !== undefined) {
      if (patch.level === null) {
        e.level_locked = false;
      } else {
        const from = e.level;
        e.level = patch.level;
        e.level_locked = true;
        memory.feedback_count++; // 与后端一致：每次手动设级记一条调级记录
        // 与后端一致：手动调级不升 version，只追加一条 history
        e.history = [
          ...e.history,
          {
            version: e.version,
            changed_fields: { level: { from, to: patch.level } },
            source_message_id: null,
            changed_at: Date.now(),
          },
        ];
      }
    }
    e.updated_at = Date.now();
    const detail: EventDetailDTO = { ...toDTO(e), sources: e.sources, history: e.history };
    return delay(detail);
  },

  getGroups() {
    return delay(
      groups.map((g) => ({ ...g, event_count: events.filter((e) => e.group_id === g.group_id).length })),
    );
  },

  patchGroup(id, patch) {
    const g = groups.find((x) => x.group_id === id);
    if (!g) return fail('群不存在', 404);
    if (patch.enabled !== undefined) g.enabled = patch.enabled;
    if (patch.course_name !== undefined) {
      g.course_name = patch.course_name === '' ? null : patch.course_name;
    }
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
    return delay(scenarios.map((s) => ({ ...s })));
  },

  replay(name) {
    const s = scenarios.find((x) => x.name === name);
    if (!s) return fail(`没有名为 ${name} 的剧本`, 404);
    filteredCount += Math.floor(s.count * 0.6);
    llmCalledCount += 1;
    s.active = true;
    return delay({ injected: s.count });
  },

  undoReplay(name) {
    const s = scenarios.find((x) => x.name === name);
    if (!s) return fail('剧本不存在', 404);
    s.active = false;
    events = events.filter((e) => e.group_id !== s.group_id);
    groups.splice(0, groups.length, ...groups.filter((g) => g.group_id !== s.group_id));
    return delay({ ok: true as const });
  },

  resetDemo() {
    for (const s of scenarios) s.active = false;
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
      ...(state === 'online' ? { uin: '10001', nickname: '演示同学' } : {}),
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

  logoutConnect() {
    localStorage.setItem('mockConnectState', 'waiting_qr');
    return delay({ ok: true as const });
  },

  startFetchNapcat() {
    mockNapcatInstalled = true;
    return delay({ ok: true as const });
  },

  getFetchNapcatProgress() {
    return delay<SetupProgressDTO>({
      status: mockNapcatInstalled ? 'done' : 'idle',
      percent: mockNapcatInstalled ? 100 : -1,
      message: '',
      installed: mockNapcatInstalled,
    });
  },

  listAccounts() {
    return delay<AccountsDTO>({
      accounts: [{ uin: '10001', current: connectState() === 'online', size_bytes: 1024 * 512, updated_at: bootAt }],
      legacy_data: false,
    });
  },

  deleteAccountData(uin) {
    if (!/^\d{5,12}$/.test(uin)) return fail('账号格式不合法', 400);
    return delay({ ok: true as const });
  },

  syncNow(days = 7) {
    if (connectState() !== 'online') return fail('QQ 未连接', 409);
    // 天数越大补回的消息越多（mock 按比例给个数）
    return delay({ groups: groups.filter((g) => g.enabled).length, messages: 4 * days });
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
      jev_filtered_count: 0,
      jev_called_count: 0,
      llm_called_count: llmCalledCount,
      uptime: Math.floor((Date.now() - bootAt) / 1000),
      pending: 0,
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

  getTodos() {
    const eventTodos = events.filter(isTodo).map(toDTO);
    const body: TodosDTO = { events: eventTodos, manual: todos.filter((t) => t.done_at === null) };
    return delay(body);
  },

  createTodo(input) {
    const title = input.title.trim();
    if (!title) return fail('标题不能为空', 400);
    const todo: TodoDTO = {
      id: nextTodoId++,
      title,
      note: input.note?.trim() ?? '',
      level: input.level ?? 2,
      done_at: null,
      created_at: Date.now(),
    };
    todos = [...todos, todo];
    return delay(todo);
  },

  patchTodo(id, patch) {
    const t = todos.find((x) => x.id === id);
    if (!t) return fail('待办不存在', 404);
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.note !== undefined) t.note = patch.note;
    if (patch.level !== undefined) t.level = patch.level;
    if (patch.done !== undefined) t.done_at = patch.done ? Date.now() : null;
    return delay({ ...t });
  },

  getTimetable() {
    return delay(structuredClone(mockTimetable));
  },

  saveTimetable(t) {
    mockTimetable.semester_start = t.semester_start;
    mockTimetable.courses = t.courses as CourseDTO[];
    return delay(structuredClone(mockTimetable));
  },

  clearTimetable() {
    mockTimetable.courses = [];
    return delay({ ok: true as const });
  },

  // 教务系统直连导入:假的验证码图 + 复用 mockTimetable 的课程
  csuStartImport() {
    const captcha =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 44">' +
          '<rect width="132" height="44" fill="#eef2f7"/>' +
          '<text x="66" y="30" font-size="22" text-anchor="middle" fill="#475569" font-family="monospace" letter-spacing="4">8k6q</text></svg>',
      );
    return delay({ session_id: 'mock-csu', captcha });
  },

  csuFetchCourses() {
    const courses = structuredClone(mockTimetable.courses) as CourseDTO[];
    return delay({ courses, warnings: [] as string[] });
  },

  getMemory() {
    const body: MemoryDTO = { enabled: memory.enabled, rules: [...memory.rules], feedback_count: memory.feedback_count };
    return delay(body);
  },

  setMemoryEnabled(enabled) {
    memory.enabled = enabled;
    const body: MemoryDTO = { enabled, rules: [...memory.rules], feedback_count: memory.feedback_count };
    return delay(body);
  },

  deleteMemoryRule(id) {
    const before = memory.rules.length;
    memory.rules = memory.rules.filter((r) => r.id !== id);
    if (memory.rules.length === before) return fail('规则不存在', 404);
    // 与后端一致：删规则只把对应记录标成 ignored，feedback_count 统计全部记录，不变
    const body: MemoryDTO = { enabled: memory.enabled, rules: [...memory.rules], feedback_count: memory.feedback_count };
    return delay(body);
  },

  clearMemory() {
    memory.rules = [];
    memory.feedback_count = 0;
    const body: MemoryDTO = { enabled: memory.enabled, rules: [], feedback_count: 0 };
    return delay(body);
  },

  getTrash() {
    return delay(trashItems());
  },

  restoreTrash(id) {
    const item = trashItems().find((t) => t.id === id);
    if (!item) return fail('这条已经不在回收站里了', 409);
    const e = events.find((x) => x.id === item.event.id)!;
    const now = Date.now();
    if (item.kind === 'cancelled') {
      const prev = item.changes['status']?.from;
      const to: EventStatus = prev === 'pending_confirm' || prev === 'done' ? prev : 'active';
      e.history = [...e.history, { version: e.version, changed_fields: { status: { from: 'cancelled', to } }, source_message_id: null, changed_at: now }];
      e.status = to;
    } else {
      const changed: HistoryDTO['changed_fields'] = {};
      const rec = e as unknown as Record<string, unknown>;
      for (const [f, c] of Object.entries(item.changes)) {
        changed[f] = { from: rec[f], to: c.from };
        rec[f] = c.from;
      }
      e.history = [...e.history, { version: e.version, changed_fields: changed, source_message_id: null, changed_at: now }];
    }
    e.updated_at = now;
    return delay(trashItems());
  },
};

// ===== 回收站（与后端 routes/trash.ts 同一套规则）

const TRASH_KEEP = 30 * DAY;
const TRASH_VANISH = ['start_at', 'end_at', 'deadline_at', 'location', 'title'];
const TRASH_RESTORABLE = ['title', 'description', 'start_at', 'end_at', 'deadline_at', 'location', 'action_required'];

function trashItems(): TrashItemDTO[] {
  const now = Date.now();
  const out: TrashItemDTO[] = [];
  for (const e of events) {
    const sourceText = (mid: string | null) => e.sources.find((s) => s.message_id === mid)?.text ?? null;
    if (e.status === 'cancelled') {
      const h = [...e.history].reverse().find((x) => x.changed_fields['status']?.to === 'cancelled');
      const at = h?.changed_at ?? e.updated_at;
      if (at < now - TRASH_KEEP) continue;
      out.push({
        id: `cancel-${e.id}`,
        kind: 'cancelled',
        by: h?.source_message_id ? 'group' : 'manual',
        event: toDTO(e),
        changes: { status: { from: h?.changed_fields['status']?.from ?? 'active', to: 'cancelled' } },
        source_text: sourceText(h?.source_message_id ?? null),
        at,
        expires_at: at + TRASH_KEEP,
      });
      continue;
    }
    const rec = e as unknown as Record<string, unknown>;
    e.history.forEach((h, i) => {
      if (h.source_message_id === null || h.changed_at < now - TRASH_KEEP) return;
      const live: HistoryDTO['changed_fields'] = {};
      for (const f of TRASH_RESTORABLE) {
        const c = h.changed_fields[f];
        if (c && (c.to ?? null) === rec[f] && (c.from ?? null) !== (c.to ?? null)) live[f] = c;
      }
      if (!TRASH_VANISH.some((f) => f in live)) return;
      out.push({
        id: `change-${e.id * 1000 + i}`,
        kind: 'changed',
        by: 'group',
        event: toDTO(e),
        changes: live,
        source_text: sourceText(h.source_message_id),
        at: h.changed_at,
        expires_at: h.changed_at + TRASH_KEEP,
      });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

let mockLlm: LlmSettingsDTO = { provider: 'deepseek', configured: false, key_hint: '', source: 'none' };
/** mock 里采集端组件默认已就绪（localStorage.mockNapcatMissing=1 可模拟缺失，调一键下载按钮） */
let mockNapcatInstalled = localStorage.getItem('mockNapcatInstalled') !== '1';
