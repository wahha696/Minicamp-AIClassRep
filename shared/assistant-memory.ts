export const ASSISTANT_EVENT_TYPES = ['exam', 'assignment', 'meeting', 'activity', 'announcement', 'other'] as const;
export type AssistantMemoryEventType = typeof ASSISTANT_EVENT_TYPES[number];
export interface AssistantMemoryRule {
  id: number;
  text: string;
  action: 'exclude_calendar' | 'note';
  course: string;
  event_types: AssistantMemoryEventType[];
  enabled: boolean;
  created_at: number;
  updated_at: number;
}
export interface AssistantSuppression {
  id: number;
  rule_id: number;
  title: string;
  course: string;
  source_count: number;
  created_at: number;
}
export interface AssistantMemoryState {
  scope: 'current_space';
  rules: AssistantMemoryRule[];
  recent_suppressions: AssistantSuppression[];
}
export interface AssistantSuppressionDetail extends AssistantSuppression {
  sources: { group_id: string; group_name: string; message_id: string; sender_name: string; text: string; sent_at: number }[];
}
