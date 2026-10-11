export type WorkspacePlatform = 'qq' | 'wechat';
export type WechatUnavailableReason = 'platform_unsupported' | 'runtime_missing' | 'unavailable';
export type WechatCapability = { available: true } | { available: false; reason: WechatUnavailableReason };
export interface WorkspaceView {
  space_id: string;
  name: string;
  bindings: { platform: WorkspacePlatform; account_id: string }[];
}
export interface WorkspacePending {
  request_id: string;
  platform: WorkspacePlatform;
  account_id: string;
  kind: 'choose' | 'switch';
  switch_required: boolean;
  target?: { space_id: string; name: string };
}
export interface WorkspaceStatus {
  enabled: true;
  current: WorkspaceView | null;
  pending: WorkspacePending[];
  wechat_available: boolean;
  wechat_unavailable_reason?: WechatUnavailableReason;
}
export type WorkspaceChoice =
  | { mode: 'create'; name: string }
  | { mode: 'current' }
  | { mode: 'known' };
export interface WorkspaceChoiceRequest {
  request_id: string;
  expected_account_epoch: string;
  choice: WorkspaceChoice;
  confirm_switch: boolean;
}
