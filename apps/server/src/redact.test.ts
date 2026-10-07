import { describe, expect, it } from 'vitest';
import { redactSensitive } from './redact.js';

describe('redactSensitive', () => {
  it('隐去 Key、Bearer、URL token、密码和用户目录，保留可排查的错误', () => {
    const raw = 'HTTP 401 Bearer abc.def API_KEY=sk-secret123456 token=url-secret&x=1 '
      + 'password:"plain-text" user_id=123456789 C:\\Users\\Alice\\ClassRep /Users/bob/ClassRep';
    const clean = redactSensitive(new Error(raw));
    for (const secret of ['abc.def', 'sk-secret123456', 'url-secret', 'plain-text', '123456789', 'Alice', 'bob']) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain('HTTP 401');
    expect(clean).toContain('[REDACTED]');
    expect(clean).toContain('[USER]');
  });
});
