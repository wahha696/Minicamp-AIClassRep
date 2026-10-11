/** Application assistant protocol. Only server registry tools are executable. */
export type AssistantPolicy = 'read' | 'confirm' | 'destructive' | 'external' | 'user_step';
export interface AssistantCapability {
  name: string;
  label: string;
  policy: AssistantPolicy;
  description: string;
  parameters: Record<string, unknown>;
}
export interface AssistantAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
  policy: AssistantPolicy;
}
export interface AssistantPlan {
  id: string;
  summary: string;
  actions: AssistantAction[];
  expiresAt: number;
  scope: 'current_space';
}
export interface AssistantResult {
  tool: string;
  ok: boolean;
  message: string;
  data?: unknown;
  /** Relative application route or fixed local download URL; never model supplied. */
  href?: string;
  requiresUser?: boolean;
  /** Only emitted by a confirmed fixed registry tool. Never execute from chat text. */
  browserAction?: {
    kind: 'pet_settings';
    patch: { visible?: boolean; style?: string; reset_image?: boolean; reset_position?: boolean };
  };
}
export interface AssistantReply {
  text: string;
  plan?: AssistantPlan;
  results?: AssistantResult[];
}
