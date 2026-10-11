import { db } from '../db/index.js';
import { defaultReminderRules, validReminderRules, type ReminderRules, type ReminderSettingsDTO } from '../../../../shared/reminders.js';

const KEY = 'reminder_rules_v1';
/** Current-space business preferences only. No credentials, channel or sending. */
export function getReminderSettings(): ReminderSettingsDTO {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(KEY);
  if (!row) return { ...defaultReminderRules(), delivery_ready: false };
  const saved = JSON.parse(String(row.value)) as { version?: unknown; rules?: unknown };
  if (saved?.version !== 1 || !validReminderRules(saved.rules) || saved.rules.enabled) throw new Error('REMINDER_SETTINGS_INVALID');
  return { ...saved.rules, delivery_ready: false };
}
export function saveReminderRules(rules: ReminderRules): ReminderSettingsDTO {
  getReminderSettings(); // Do not silently replace a damaged/future preference.
  if (!validReminderRules(rules) || rules.enabled) throw new Error('REMINDER_SETTINGS_INVALID');
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY, JSON.stringify({ version: 1, rules }));
  return { ...rules, delivery_ready: false };
}
