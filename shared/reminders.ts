/** No channel, device binding or network activity is implied by these rules. */
export interface ReminderRules {
  enabled: boolean;
  before_minutes: number[];
  daily_limit: number;
  quiet_hours: 'none';
  missed_policy: 'once_before_deadline';
}
export interface ReminderSettingsDTO extends ReminderRules {
  delivery_ready: false;
}

export function defaultReminderRules(): ReminderRules {
  return { enabled: false, before_minutes: [24 * 60, 2 * 60], daily_limit: 10,
    quiet_hours: 'none', missed_policy: 'once_before_deadline' };
}

export function validReminderRules(value: unknown): value is ReminderRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rules = value as Partial<ReminderRules>;
  return typeof rules.enabled === 'boolean' && Array.isArray(rules.before_minutes)
    && Number.isSafeInteger(rules.daily_limit) && rules.daily_limit! > 0
    && rules.quiet_hours === 'none' && rules.missed_policy === 'once_before_deadline'
    && rules.before_minutes.length > 0 && rules.before_minutes.length <= 16
    && rules.before_minutes.every(minutes => Number.isSafeInteger(minutes) && minutes > 0
      && Number.isSafeInteger(minutes * 60_000))
    && new Set(rules.before_minutes).size === rules.before_minutes.length;
}
