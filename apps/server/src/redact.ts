/**
 * 用于本地日志和可分享诊断的最后一道脱敏。
 * 不依赖当前配置值，避免“先记日志、后读配置”时泄漏。
 */
export function redactSensitive(value: unknown): string {
  let text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  text = text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_KEY]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|classrep_lan(?:_epoch)?|token|password|passwd|secret)(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
    )
    // QQ、群、消息和学号通常是 5–12 位数字；日志不需要保留这些可识别值。
    .replace(/(?<!\d)\d{5,12}(?!\d)/g, '[REDACTED_ID]')
    .replace(/([A-Za-z]:\\Users\\)[^\\/\s]+/gi, '$1[USER]')
    .replace(/(\/Users\/|\/home\/)[^/\s]+/g, '$1[USER]');
  return text;
}
