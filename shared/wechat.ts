/** Local opt-in preparation contracts. No account/PID is accepted from HTTP. */
export interface WechatConnectionDTO {
  nickname?: string;
  state: 'idle' | 'connecting' | 'identified' | 'error';
  connection_id: string | null;
  error: string | null;
  collecting: false;
}
export interface WechatCatalogDTO {
  state: 'idle' | 'reading' | 'stopping' | 'ready' | 'error';
  error: string | null;
  collecting: false;
  scope: { connection_id: string; account_epoch: string } | null;
  catalog: { catalog_id: string; groups: { group_id: string; name: string | null }[] } | null;
  selected_group_ids: string[];
}
export interface WechatCatalogRefresh {
  expected_account_epoch: string;
  data_root: string;
  approve_key_read: true;
  approve_contact_read: true;
}
export interface WechatGroupChoice {
  expected_account_epoch: string;
  catalog_id: string;
  group_ids: string[];
}
export interface WechatIntakeDTO {
  state: 'idle' | 'opening' | 'collecting' | 'error';
  error: string | null;
  collecting: boolean;
  intake_id: string | null;
  last_received_at: number | null;
  scope: { connection_id: string; account_epoch: string } | null;
  groups: { group_id: string; pending: number; deferred: number }[];
}
export interface WechatIntakeStart extends WechatGroupChoice {
  connection_id: string;
  approve_key_read: true;
  approve_message_read: true;
  approve_selected_storage: true;
}
export interface WechatIntakeRequest { expected_account_epoch: string; intake_id: string }
export interface WechatHistoryRequest extends WechatIntakeRequest {
  group_id: string; days: 1 | 7 | 30; approve_history_read: true; continue_existing: boolean;
}
export interface WechatIssueDTO {
  event_id: string; group_id: string; reason: string;
}
