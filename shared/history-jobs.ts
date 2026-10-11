/** Durable per-space history jobs. Counts are committed pages / newly stored messages. */
export type HistoryPlatform = 'qq' | 'wechat';
export type HistoryJobStatus = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'interrupted';
export interface HistoryGroupProgress {
  group_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  pages: number;
  messages: number;
  error: string | null;
}
export interface HistoryJobDTO {
  id: string;
  platform: HistoryPlatform;
  days: 1 | 7 | 30;
  status: HistoryJobStatus;
  created_at: number;
  updated_at: number;
  groups_total: number;
  groups_completed: number;
  pages: number;
  messages: number;
  current_group_id: string | null;
  /** QQ still owns the original request; silence is not proof of failure. */
  waiting_since?: number | null;
  error: string | null;
  retryable: boolean;
  groups: HistoryGroupProgress[];
}
export interface CreateHistoryJobRequest {
  platform: HistoryPlatform;
  days: 1 | 7 | 30;
  expected_account_epoch: string;
  group_ids?: string[];
  intake_id?: string;
  approve_history_read?: true;
}
export interface HistoryJobMutationRequest {
  expected_account_epoch: string;
  intake_id?: string;
}
export interface HistoryJobResponse { job: HistoryJobDTO }
export interface HistoryJobsResponse { jobs: HistoryJobDTO[] }
