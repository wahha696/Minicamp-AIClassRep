// 从 docs/分工/00-总约定.md §4 逐字复制（前端单独一份）。改动须四人同意，先改总约定再改这里。

// ===== 时间约定：所有时间一律为「毫秒时间戳 number」（数据库、函数、API 全部如此）。
// ===== 只有在「给 LLM 的 prompt」「.ics 文件」「页面显示」这三处才转成 Asia/Shanghai 文本。
// ===== 所有 id（群号、消息 id）一律为 string。

export type EventType = 'exam' | 'assignment' | 'meeting' | 'activity' | 'announcement' | 'other';
export type EventStatus = 'active' | 'cancelled' | 'done' | 'pending_confirm';
export type EventProposalKind = 'create' | 'update' | 'cancel';
export type EventProposalReason = 'low_confidence' | 'manual_lock_conflict';
export type EventEditableField =
  | 'title'
  | 'description'
  | 'start_at'
  | 'end_at'
  | 'deadline_at'
  | 'location'
  | 'action_required';
/** 危机等级：1 低、2 中、3 高、4 紧急 */
export type Level = 1 | 2 | 3 | 4;
export type ConnectState =
  | 'qq_conflict' | 'error' | 'kicked' | 'online' | 'waiting_qr' | 'reconnecting' | 'starting';
export type MessageSource = 'onebot' | 'history' | 'demo' | 'import' | 'forward';

/** 所有来源最终都转成它再入库 */
export interface Message {
  message_id: string;   // onebot/history: String(message_id)；demo: `demo-<剧本名>-<序号>`；import: `import-<时间戳>-<序号>`
  group_id: string;     // demo/import 的群号以 `demo-` 开头
  group_name: string;
  sender_name: string;  // 只存昵称，不存 QQ 号
  text: string;         // 已把消息段转成纯文本（[图片]、[at] 等占位符）
  sent_at: number;
}

export interface EventDTO {
  id: number;
  group_id: string;
  group_name: string;
  type: EventType;
  title: string;
  description: string;
  start_at: number | null;
  end_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null;
  status: EventStatus;
  confidence: number;   // 0~1
  level: Level;
  level_locked: boolean; // 用户手动设过 = true；AI 更新时不改 level
  manual_locked_fields: EventEditableField[];
  version: number;
  created_at: number;
  updated_at: number;
}

export interface SourceMessageDTO {
  message_id: string;
  sender_name: string;
  text: string;
  sent_at: number;
}

export interface HistoryDTO {
  version: number;
  changed_fields: Record<string, { from: unknown; to: unknown }>;
  source_message_id: string | null;
  changed_at: number;
}

export interface EventProposalDTO {
  id: number;
  kind: EventProposalKind;
  reason: EventProposalReason;
  changes: Partial<Record<EventEditableField | 'level' | 'status', { from: unknown; to: unknown }>>;
  source_message_ids: string[];
  confidence: number;
  base_version: number;
  created_at: number;
}

/** PATCH /api/events/:id。version 保留通知版本；updated_at 令牌拦住多个页面的静默覆盖。 */
export interface EventPatch {
  expected_version?: number;
  /** 每次事件详情或待确认提案变化都会前进的单调并发令牌。 */
  expected_updated_at?: number;
  status?: EventStatus;
  level?: Level | null;
  title?: string;
  description?: string;
  start_at?: number | null;
  end_at?: number | null;
  deadline_at?: number | null;
  location?: string | null;
  action_required?: string | null;
  unlock_fields?: EventEditableField[];
}

export interface EventDetailDTO extends EventDTO {
  sources: SourceMessageDTO[];
  history: HistoryDTO[];
  pending_proposals: EventProposalDTO[];
}

/**
 * 回收站的一项（设置页「回收站」）：从日历上消失、可以一键恢复的，只列最近 30 天。
 * - cancelled：被取消的事件（by=manual 自己取消 / group 群消息取消），恢复 = 回到取消前的状态
 * - changed：群消息改期 / 改地点 / 改标题前的旧版本（by 恒为 group），恢复 = 这些字段改回 from
 */
export interface TrashItemDTO {
  id: string;                 // 'cancel-<事件 id>' | 'change-<history id>'，恢复时原样传回
  kind: 'cancelled' | 'changed';
  by: 'manual' | 'group';
  event: EventDTO;            // 事件现在的样子
  changes: Record<string, { from: unknown; to: unknown }>; // cancelled 时为 { status: {from,to} }
  source_text: string | null; // 触发这次取消 / 改动的群消息原文（快照）；手动取消为 null
  at: number;                 // 取消 / 改动的时间
  expires_at: number;         // at + 30 天，过了就不在回收站显示（库里仍保留）
}

export interface TodayDTO {
  date: string;         // 'YYYY-MM-DD'（Asia/Shanghai）
  summary: string;      // 如 "今天 4 件事，最急的是 14:00 高数小测"；没有事件时 "今天没有待办，轻松一天"
  events: EventDTO[];
}

export interface GroupDTO {
  group_id: string;
  name: string;
  enabled: boolean;
  message_count: number;
  event_count: number;
  course_name: string | null; // 用户指定的对应课程名；null = AI 按群名猜
}

export interface TodoDTO {
  id: number;
  title: string;
  note: string;
  level: Level;
  done_at: number | null;
  created_at: number;
}

export interface TodosDTO {
  events: EventDTO[]; // 群里提取出的待办类事件
  manual: TodoDTO[];  // 用户手动添加的待办（未完成的）
}

import type { CourseDTO } from '../../../../shared/timetable';
export type { CourseDTO, TimetableDTO } from '../../../../shared/timetable';

export interface LevelRuleDTO {
  id: number;
  text: string;
  level: Level;
}

export interface MemoryDTO {
  enabled: boolean;
  rules: LevelRuleDTO[];
  feedback_count: number;
}

export interface DesktopQQStatusDTO {
  supported: boolean;
  state: 'idle' | 'opening' | 'qq' | 'resuming' | 'error';
  session_id?: string;
  uin?: string;
  paused_at?: number;
  message?: string;
}

export interface ConnectStatusDTO {
  desktop_qq?: DesktopQQStatusDTO;
  state: ConnectState;
  /** 当前账号库租约；前端业务读写都带回，换号后旧页面请求会被后端拒绝。 */
  account_epoch: string;
  uin?: string;
  nickname?: string;    // online 时登录者的 QQ 昵称（get_login_info；取不到就没有）
  since: number;        // 进入当前状态的时间
  message?: string;     // error 时的用户文案（架构.md §7）
  first_run: boolean;   // 没有 uin 或 DeepSeek 未配置 → 前端拦到 /setup 向导（修复计划第一节 §5）
  deepseek_configured?: boolean; // DeepSeek Key 是否已配置（网页或 .env）
  reason?: 'no_qq' | 'no_napcat'; // error 细分：缺 QQ 电脑版 / 缺采集端运行包（给一键下载）
  legacy_data?: boolean; // 检测到旧版单库数据被迁到 data/accounts/legacy（提示一次）
}

/** 连接控制按钮点击时冻结的账号快照；旧页面不能重启、退出或擦除后来登录的账号。 */
export interface AccountControlContext {
  accountEpoch: string;
  uin: string | null;
}

/** GET/POST /api/setup/*：采集端组件一键下载（问题 3） */
export interface SetupProgressDTO {
  status: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error';
  percent: number;   // 下载中 0~99，完成 100，未开始/不可用 -1
  message: string;
  installed: boolean; // napcat/NapCatWinBootMain.exe 是否已就绪
}

/** GET /api/accounts：本机账号库列表（问题 1 延伸：账号数据管理） */
export interface AccountDTO {
  uin: string;
  current: boolean;
  size_bytes: number;
  updated_at: number;
}

export interface AccountsDTO {
  accounts: AccountDTO[];
  legacy_data: boolean;
}

export interface PipelineStats {
  filtered_count: number;    // 累计被规则或 Jev 过滤掉的消息数
  jev_filtered_count: number;
  jev_called_count: number;
  llm_called_count: number;  // 累计 LLM 调用次数
  llm: 'ok' | 'error' | 'unconfigured';  // 最近一次调用结果；没配 key 为 unconfigured
  jev: 'ok' | 'error' | 'unconfigured' | 'disabled';
  jev_mode?: 'jev' | 'local' | 'dual';   // ENABLE_JEV=false 时缺省
  jev_route?: 'jev' | 'local';           // 仅 dual
  jev_local?: 'ok' | 'backoff' | 'unconfigured'; // 仅 local/dual
}

export interface HealthDTO extends PipelineStats {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  qq: ConnectState;
  uptime: number;       // 秒
  pending: number;      // 待整理（processed=0 且未被过滤）的消息数，只算启用的群
  /** DEMO_MODE 且账号就绪时附带：最近 dual 批摘要（无原文） */
  dual_score_log?: Array<{
    at: number;
    groupName: string;
    n: number;
    remote: number[] | null;
    local: number[] | null;
    routed: number[] | null;
    routeBackend: 'jev' | 'local';
  }>;
}

// ===== 以下为前端补充（§7 里只写在表格中、§4 没有命名的返回类型）

export interface ScenarioDTO {
  name: string;
  title: string;
  count: number;
  /** 剧本对应的演示群 */
  group_id: string;
  /** 已回放且没取消（演示群里有数据）→ 页面显示「取消」 */
  active: boolean;
}

/** GET/PUT /api/settings/llm：连接页「AI 接入」卡片。key 只返回打码后的提示，不回传明文 */
export type LlmProvider = 'deepseek';

export interface LlmSettingsDTO {
  provider: LlmProvider;
  configured: boolean;
  key_hint: string;                 // 例如 sk-****367f；没配为 ''
  source: 'web' | 'env' | 'none';   // web=网页保存的；env=.env 里的
  /** 落盘保护态（R8）：dpapi=Windows 加密；plain=降级明文（界面须提示）；none=未配置/来自 env */
  protection?: 'dpapi' | 'plain' | 'none';
}

// ===== /api/settings/ai（修复计划 3.2）：DeepSeek 必填 + Jev/TypeSafe 可选 =====

export interface AiKeyStatusDTO {
  configured: boolean;
  key_hint: string;
  source: 'web' | 'env' | 'none';
}

export interface AiSettingsDTO {
  deepseek: AiKeyStatusDTO & { provider: LlmProvider; protection?: 'dpapi' | 'plain' | 'none' };
  jev: AiKeyStatusDTO & { enabled: boolean; mode: 'jev' | 'local' | 'dual'; local_configured: boolean };
}

/** POST /api/settings/ai/test 的返回：target 省略时两个都测 */
export interface AiTestResultDTO {
  deepseek?: { ok: boolean; error?: string };
  jev?: { ok: boolean; error?: string };
}

// ===== /api/settings/lan：局域网只读开关（设置页「手机访问」卡片） =====

export interface LanSettingsDTO {
  enabled: boolean;
  /** 开关状态和实际监听不一致 = 重启后端才生效 */
  restart_required: boolean;
  /** 开关还开着但链接绑定已失效（重启/换号后），需要重新签发 */
  account_rebind_required: boolean;
  /** 手机扫码/复制打开的完整链接（带 token） */
  urls: string[];
}

// ===== 中南教务系统(csujwc)直连导入(课表页) =====

/** POST /api/timetable/csu/start:返回会话 id 与验证码图片(data URL,直接 <img>;空串=本次登录不需要验证码) */
export interface CsuImportStartDTO {
  session_id: string;
  captcha: string;
}

/** POST /api/timetable/csu/fetch:解析好的课次(不落库,走预览确认流程) */
export interface CsuImportResultDTO {
  items?: import('../../../../shared/timetable').ImportItem[];
  semesterStart?: string;
  courses: CourseDTO[];
  warnings: string[];
}
