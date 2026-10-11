// Operator-only candidates. No application imports, data reads, background loop or automatic sends.
import { randomUUID } from 'node:crypto';

const ORIGIN = 'https://www.pushplus.plus';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(value);
const positiveSeconds = value => {
  const number = typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const accessFailures = new WeakMap();
const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function accessFailure(message, diagnostic) {
  const error = new Error(message);
  accessFailures.set(error, Object.freeze({ stage: 'get_access_key', ...diagnostic }));
  return error;
}

/** Only metadata constructed here, never arbitrary error properties or server text. */
export function reminderProbeFailureDiagnostic(error) {
  return accessFailures.get(error);
}

async function requestJson(fetcher, path, init) {
  try {
    const response = await fetcher(`${ORIGIN}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Keep the known HTTP status. */ }
      return { ok: false, http: response.status, reason: 'http_rejected' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, http: response.status, reason: 'empty_body' };
    let size = 0, text = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) { await reader.cancel(); return { ok: false, http: response.status, reason: 'body_too_large' }; }
        text += decoder.decode(part.value, { stream: true });
      }
      let body;
      try { body = JSON.parse(text + decoder.decode()); }
      catch { return { ok: false, http: response.status, reason: 'invalid_json' }; }
      return body && typeof body === 'object' && !Array.isArray(body)
        ? { ok: true, body, http: response.status }
        : { ok: false, http: response.status, reason: 'invalid_object' };
    } finally { reader.releaseLock(); }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    return { ok: false, reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error',
      ...(networkCodes.has(code) ? { network: code } : {}) };
  }
}

/** Explicit one-shot synthetic send. A timeout is ambiguous and never triggers another send. */
export async function sendPushplusTest({ approve, token, recipient, self = false, fetcher = fetch }) {
  if (approve !== true) throw new Error('TEST_SEND_CONSENT_REQUIRED');
  if (!validToken(token) || (self !== true && (typeof recipient !== 'string' || !/^[a-f0-9]{32}$/i.test(recipient)))
    || (self === true && recipient !== undefined)) throw new Error('TEST_CREDENTIALS_INVALID');
  const result = await requestJson(fetcher, '/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...(self ? {} : { to: recipient }), channel: 'wechat', template: 'txt',
      title: '课代表手机提醒测试', content: `标题：人工提醒测试\n截止时间：未设置（测试）\n群名：人工测试群\n摘要：这是一条人工测试，无真实聊天内容。\n标记：${randomUUID()}` }),
  });
  if (!result.ok) return { state: 'unknown', ...(result.http ? { http: result.http } : {}) };
  const { code, data } = result.body;
  if (code !== 200) return { state: 'rejected', ...(typeof code === 'number' ? { code } : {}) };
  return typeof data === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data)
    ? { state: 'accepted', receipt: data } : { state: 'unknown' };
}

/** Secret result stays with the caller; never pass this return value to console/logging. */
export async function acquirePushplusTestAccess({ token, secretKey, fetcher = fetch }) {
  if (!validToken(token) || typeof secretKey !== 'string' || secretKey.length < 16 || secretKey.length > 512
    || /[\u0000-\u001f\u007f]/.test(secretKey) || secretKey.trim() !== secretKey) throw new Error('TEST_CREDENTIALS_INVALID');
  const result = await requestJson(fetcher, '/api/common/openApi/getAccessKey', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, secretKey }),
  });
  if (!result.ok) throw accessFailure('TEST_ACCESS_UNAVAILABLE', {
    reason: result.reason, ...(result.http ? { http: result.http } : {}), ...(result.network ? { network: result.network } : {}),
  });
  const metadata = { http: result.http,
    ...(Number.isSafeInteger(result.body.code) && Math.abs(result.body.code) <= 999999 ? { code: result.body.code } : {}) };
  if (result.body.code === 403) throw accessFailure('TEST_ACCESS_IP_UNAUTHORIZED', { ...metadata, reason: 'channel_rejected' });
  if (result.body.code === 401) throw accessFailure('TEST_ACCESS_UNAUTHORIZED', { ...metadata, reason: 'channel_rejected' });
  if (result.body.code !== 200) throw accessFailure('TEST_ACCESS_UNAVAILABLE', { ...metadata, reason: 'channel_rejected' });
  // This operator-only helper uses the key immediately once; it never caches or
  // refreshes it. Unknown expiry must not invent a TTL or block the actual API check.
  // Official prose uses expireIn; its response example/schema use expiresIn.
  const data = result.body.data;
  const expiry = positiveSeconds(data?.expiresIn ?? data?.expireIn);
  if (!validToken(data?.accessKey)
    || (data.expiresIn !== undefined && data.expireIn !== undefined
      && positiveSeconds(data.expiresIn) !== positiveSeconds(data.expireIn))) throw accessFailure('TEST_ACCESS_UNAVAILABLE', {
        ...metadata, reason: 'access_schema_invalid', key_format_valid: validToken(result.body.data?.accessKey),
        expiry_valid: expiry !== null,
      });
  return { accessKey: data.accessKey, expiresIn: expiry };
}

/** Only predefined messages; never print a response body or arbitrary exception. */
export function reminderProbeFailureHint(error) {
  if (accessFailures.get(error)?.reason === 'access_schema_invalid') {
    return 'PushPlus 已返回成功，但 AccessKey 响应字段未通过校验；请反馈下方诊断，无需先修改网络或安全 IP。';
  }
  const hints = {
    TEST_ACCESS_IP_UNAUTHORIZED: 'PushPlus 返回 403：请将本次请求电脑的公网 IP 加入安全 IP 列表；不要填写局域网 IP。',
    TEST_ACCESS_UNAUTHORIZED: 'PushPlus 返回 401：请核对开放接口是否开启，以及用户 Token 和 SecretKey 是否正确。',
    TEST_CREDENTIALS_INVALID: '凭据格式不正确：Token 与 SecretKey 是两项不同设置，请重新核对本机输入。',
    TEST_ACCESS_UNAVAILABLE: '未取得有效 AccessKey：请检查网络和 PushPlus 开放接口设置，不会自动重试。',
  };
  return error instanceof Error && Object.hasOwn(hints, error.message) ? hints[error.message]
    : '人工验证未完成，请检查模式、凭据及 PushPlus 开放接口设置；没有自动重发，也未输出凭据。';
}

export async function queryPushplusTest({ accessKey, receipt, fetcher = fetch }) {
  if (!validToken(accessKey) || typeof receipt !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt)) throw new Error('TEST_CREDENTIALS_INVALID');
  const result = await requestJson(fetcher, `/api/open/message/sendMessageResult?shortCode=${encodeURIComponent(receipt)}`, {
    method: 'GET', headers: { 'access-key': accessKey },
  });
  if (!result.ok || result.body.code !== 200) return { state: 'unknown' };
  return { state: ({ 0: 'pending', 1: 'sending', 2: 'channel_reported_sent', 3: 'failed' })[result.body.data?.status] ?? 'unknown' };
}

/** Creates a single-scan candidate QR only. It does not bind a ClassRep user. */
export async function createPushplusTestQr({ approve, accessKey, fetcher = fetch }) {
  if (approve !== true) throw new Error('TEST_QR_CONSENT_REQUIRED');
  if (!validToken(accessKey)) throw new Error('TEST_CREDENTIALS_INVALID');
  const nonce = randomUUID();
  const result = await requestJson(fetcher, `/api/open/friend/getQrCode?content=${nonce}&second=300&scanCount=1`, {
    method: 'GET', headers: { 'access-key': accessKey },
  });
  if (!result.ok || result.body.code !== 200) return { state: 'unavailable' };
  try {
    const url = new URL(result.body.data?.qrCodeImgUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port || url.pathname !== '/cgi-bin/showqrcode') return { state: 'unavailable' };
    return { state: 'qr_created', image: url.href, binding_verified: false };
  } catch { return { state: 'unavailable' }; }
}

/** Synthetic one-off calendar proof: alarm 5 minutes from creation, deadline 10 minutes. */
export function buildCalendarProbe(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8000000000000000) throw new Error('TEST_TIME_INVALID');
  const utc = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fold = line => {
    let output = '', bytes = 0;
    for (const char of line) {
      const width = Buffer.byteLength(char, 'utf8');
      if (bytes + width > 75) { output += '\r\n '; bytes = 1; }
      output += char; bytes += width;
    }
    return output;
  };
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ClassRep//Reminder feasibility//CN',
    'BEGIN:VEVENT', `UID:classrep-probe-${randomUUID()}@classrep`, `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(now + 600000)}`, 'SUMMARY:课代表人工日历提醒测试',
    'DESCRIPTION:仅验证手机日历提醒。无真实事项。导入后请核对提醒并可手动删除。',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'DESCRIPTION:课代表人工提醒测试',
    'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].map(fold).join('\r\n');
}
