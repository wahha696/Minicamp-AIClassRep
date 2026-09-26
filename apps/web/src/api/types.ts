// 从 docs/分工/00-总约定.md §4 逐字复制（前端单独一份）。改动须四人同意，先改总约定再改这里。

// ===== 时间约定：所有时间一律为「毫秒时间戳 number」（数据库、函数、API 全部如此）。
// ===== 只有在「给 LLM 的 prompt」「.ics 文件」「页面显示」这三处才转成 Asia/Shanghai 文本。
// ===== 所有 id（群号、消息 id）一律为 string。

export type EventType = 'exam' | 'assignment' | 'meeting' | 'activity' | 'announcement' | 'other';
export type EventStatus = 'active' | 'cancelled' | 'done' | 'pending_confirm';
export type ConnectState =
  | 'qq_conflict' | 'error' | 'kicked' | 'online' | 'waiting_qr' | 'reconnecting' | 'starting';
export type MessageSource = 'onebot' | 'history' | 'demo' | 'import';

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

export interface EventDetailDTO extends EventDTO {
  sources: SourceMessageDTO[];
  history: HistoryDTO[];
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
}

export interface ConnectStatusDTO {
  state: ConnectState;
  uin?: string;
  nickname?: string;    // online 时登录者的 QQ 昵称（get_login_info；取不到就没有）
  since: number;        // 进入当前状态的时间
  message?: string;     // error 时的用户文案（架构.md §7）
  first_run: boolean;   // 从未登录过（无 uin）且库里没有任何消息/事件 → 前端拦到 /connect
}

export interface PipelineStats {
  filtered_count: number;    // 累计被规则或 Jev 过滤掉的消息数
  jev_filtered_count: number;
  jev_called_count: number;
  llm_called_count: number;  // 累计 LLM 调用次数
  llm: 'ok' | 'error' | 'unconfigured';  // 最近一次调用结果；没配 key 为 unconfigured
  jev: 'ok' | 'error' | 'unconfigured' | 'disabled';
}

export interface HealthDTO extends PipelineStats {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  qq: ConnectState;
  uptime: number;       // 秒
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
}
