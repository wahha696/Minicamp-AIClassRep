import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountBackupStatus } from './accounts.js';
import { getAiSettings } from './ai-settings.js';
import { db, SCHEMA_VERSION } from './db/index.js';
import { getPipelineStats } from './pipeline/index.js';
import { ROOT } from './paths.js';

export const DECISION_EXPLANATIONS = {
  pending: '尚未进入完整处理批次',
  rule_noise: '命中本地确定性噪声规则，未发送给 AI',
  jev_below_threshold: '本地快判认为不是日程通知，未发送给大模型',
  llm_no_event: '大模型看过，但没有返回需要新增或修改的事项',
  event_recognized: '已识别并关联到日程',
  pending_confirmation: '识别到低置信度或与人工修改冲突的变更，等待用户确认',
  pipeline_error: '处理过程中发生非网络错误，未生成可靠日程',
  legacy_filtered: '旧版本曾过滤，升级前未记录更细原因',
  legacy_processed: '旧版本已处理，升级前未记录更细原因',
} as const;

type DecisionReason = keyof typeof DECISION_EXPLANATIONS;

interface DiagnosticRow {
  group_id: string;
  sent_at: number;
  source: string;
  processed: number;
  filtered_out: number;
  decision_reason: string;
  text_length: number;
  has_time_hint: number;
  has_placeholder: number;
  event_types: string;
  event_statuses: string;
}

function normalizedReason(row: DiagnosticRow): DecisionReason {
  if (row.decision_reason in DECISION_EXPLANATIONS && row.decision_reason !== 'pending') {
    return row.decision_reason as DecisionReason;
  }
  if (row.processed === 0) return 'pending';
  return row.filtered_out ? 'legacy_filtered' : 'legacy_processed';
}

function appVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'app', 'version.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : 'development';
  } catch {
    return 'development';
  }
}

/**
 * 诊断报告只含分类理由和形态特征：不含消息 id、群号/群名、正文、事件标题、QQ 号、路径或 Key。
 * group-1 等别名只在本报告内有效，便于看同一群的连续决策。
 */
export function createDiagnosticReport(limit = 500, now = Date.now()): Record<string, unknown> {
  const rows = db.prepare(
    `SELECT m.group_id, m.sent_at, m.source, m.processed, m.filtered_out, m.decision_reason,
            length(m.text) AS text_length,
            CASE WHEN m.text GLOB '*[0-9]:[0-9]*' OR m.text LIKE '%今天%' OR m.text LIKE '%明天%'
                       OR m.text LIKE '%周_%' OR m.text LIKE '%截止%' THEN 1 ELSE 0 END AS has_time_hint,
            CASE WHEN m.text LIKE '%[图片]%' OR m.text LIKE '%[at]%' OR m.text LIKE '%[文件]%'
                 THEN 1 ELSE 0 END AS has_placeholder,
            COALESCE((SELECT group_concat(DISTINCT e.type)
                        FROM event_sources es JOIN events e ON e.id = es.event_id
                       WHERE e.group_id = m.group_id AND es.message_id = m.message_id), '') AS event_types,
            COALESCE((SELECT group_concat(DISTINCT e.status)
                        FROM event_sources es JOIN events e ON e.id = es.event_id
                       WHERE e.group_id = m.group_id AND es.message_id = m.message_id), '') AS event_statuses
       FROM messages m ORDER BY m.sent_at DESC, m.message_id DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(2000, limit))) as unknown as DiagnosticRow[];

  const groups = new Map<string, string>();
  const counts: Record<string, number> = {};
  const messages = rows.map((row, index) => {
    if (!groups.has(row.group_id)) groups.set(row.group_id, `group-${groups.size + 1}`);
    const reason = normalizedReason(row);
    counts[reason] = (counts[reason] ?? 0) + 1;
    return {
      ref: `message-${index + 1}`,
      group: groups.get(row.group_id),
      age_hours: Math.max(0, Math.floor((now - row.sent_at) / 3_600_000)),
      source: row.source,
      processed: row.processed === 1,
      decision: reason,
      explanation: DECISION_EXPLANATIONS[reason],
      text_shape: {
        length: row.text_length,
        has_time_hint: row.has_time_hint === 1,
        has_attachment_placeholder: row.has_placeholder === 1,
      },
      linked_event_types: row.event_types ? row.event_types.split(',').sort() : [],
      linked_event_statuses: row.event_statuses ? row.event_statuses.split(',').sort() : [],
    };
  });
  const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
  const ai = getAiSettings();
  return {
    format: 'classrep-diagnostic-v1',
    created_at: new Date(now).toISOString(),
    privacy: 'No message text, message/group/QQ identifiers, names, file paths or API keys are included.',
    runtime: { app_version: appVersion(), node: process.versions.node, platform: process.platform, arch: process.arch },
    database: { schema_version: SCHEMA_VERSION, integrity: integrity?.quick_check ?? 'unknown' },
    ai: { deepseek_configured: ai.deepseek.configured, jev_configured: ai.jev.configured },
    pipeline: getPipelineStats(true),
    backups: accountBackupStatus(),
    decision_counts: counts,
    decision_explanations: DECISION_EXPLANATIONS,
    messages,
  };
}
