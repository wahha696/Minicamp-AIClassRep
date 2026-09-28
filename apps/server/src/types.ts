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
  manual_locked_fields: EventEditableField[]; // 用户手动修正后，AI 不再覆盖这些字段
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

export type { CourseDTO, TimetableDTO } from '../../../shared/timetable.js';

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

export interface ConnectStatusDTO {
  state: ConnectState;
  account_epoch: string; // 不含账号信息的数据代次令牌；前端业务读写用它拒绝跨号请求
  uin?: string;
  nickname?: string;    // online 时登录者的 QQ 昵称（get_login_info；取不到就没有）
  since: number;        // 进入当前状态的时间
  message?: string;     // error 时的用户文案（架构.md §7）
  first_run: boolean;   // 没有 uin 或 LLM 未配置 → 前端拦到 /setup 向导（修复计划第一节 §5）
  deepseek_configured: boolean; // DeepSeek Key 是否已配置（网页或 .env）
  reason?: 'no_qq' | 'no_napcat'; // error 细分：没装 QQ / 缺采集端运行包（前端据此给一键下载）
  legacy_data?: boolean; // 检测到旧版单库数据被迁到 data/accounts/legacy（前端提示一次）
}

export interface PipelineStats {
  filtered_count: number;    // 累计被规则或 Jev 过滤掉的消息数
  jev_filtered_count: number; // 本进程 Jev 累计过滤的消息数
  jev_called_count: number; // 本进程 Jev 累计调用次数
  llm_called_count: number;  // 累计 LLM 调用次数
  llm: 'ok' | 'error' | 'unconfigured';  // 最近一次调用结果；没配 key 为 unconfigured
  jev: 'ok' | 'error' | 'unconfigured' | 'disabled';
}

export interface HealthDTO extends PipelineStats {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  qq: ConnectState;
  uptime: number;       // 秒
  pending: number;      // 待整理（processed=0 且未被过滤）的消息数，只算启用的群
}
