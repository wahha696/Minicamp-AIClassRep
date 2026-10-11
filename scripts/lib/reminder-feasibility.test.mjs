import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquirePushplusTestAccess, buildCalendarProbe, createPushplusTestQr, queryPushplusTest, sendPushplusTest, reminderProbeFailureHint, reminderProbeFailureDiagnostic } from './reminder-feasibility.mjs';

const token = 'synthetic_token_for_test';
const recipient = '1'.repeat(32);
test('AccessKey 失败分阶段诊断，只保留固定元数据，不重试或暴露服务端/异常内容', async () => {
  const cases = [
    [async () => { throw Object.assign(new Error(token), { cause: { code: 'ENOTFOUND', secret: token } }); },
      { reason: 'network_error', network: 'ENOTFOUND' }],
    [async () => { throw Object.assign(new Error(token), { cause: { code: token } }); }, { reason: 'network_error' }],
    [async () => { throw new DOMException(token, 'TimeoutError'); }, { reason: 'timeout' }],
    [async () => new Response(token, { status: 403 }), { reason: 'http_rejected', http: 403 }],
    [async () => new Response(token), { reason: 'invalid_json', http: 200 }],
    [async () => new Response('x'.repeat(65537)), { reason: 'body_too_large', http: 200 }],
    [async () => Response.json([]), { reason: 'invalid_object', http: 200 }],
    [async () => Response.json({ code: 500, msg: token, data: token }), { http: 200, code: 500, reason: 'channel_rejected' }],
    [async () => Response.json({ code: token, msg: token }), { http: 200, reason: 'channel_rejected' }],
    [async () => Response.json({ code: 200, data: { accessKey: 'invalid', expiresIn: '7200' } }),
      { http: 200, code: 200, reason: 'access_schema_invalid', key_format_valid: false, expiry_valid: true }],
  ];
  for (const [response, expected] of cases) {
    let calls = 0, caught;
    try { await acquirePushplusTestAccess({ token, secretKey: token, fetcher: (...args) => { calls++; return response(...args); } }); }
    catch (error) { caught = error; }
    assert.ok(caught);
    assert.deepEqual(reminderProbeFailureDiagnostic(caught), { stage: 'get_access_key', ...expected });
    assert.ok(!JSON.stringify(reminderProbeFailureDiagnostic(caught)).includes(token));
    assert.equal(calls, 1);
  }
  assert.equal(reminderProbeFailureDiagnostic(Object.assign(new Error(token), { diagnostic: { secret: token } })), undefined);
});
test('一次性操作兼容字符串有效期；缺失或不识别时不虚构寿命，仍须后续接口验证凭据', async () => {
  for (const fields of [{ expiresIn: '7200' }, { expireIn: '7200' }, { expiresIn: 7200, expireIn: '7200' }]) {
    const access = await acquirePushplusTestAccess({ token, secretKey: token,
      fetcher: async () => Response.json({ code: 200, data: { accessKey: token, ...fields } }) });
    assert.deepEqual(access, { accessKey: token, expiresIn: 7200 });
  }
  for (const expiry of [undefined, null, 0, -1, true, 'not_a_duration', 'Infinity', '1e3', {}, Number.MAX_SAFE_INTEGER + 1]) {
    const access = await acquirePushplusTestAccess({ token, secretKey: token,
      fetcher: async () => Response.json({ code: 200, data: { accessKey: token, expiresIn: expiry } }) });
    assert.deepEqual(access, { accessKey: token, expiresIn: null });
    const qr = await createPushplusTestQr({ approve: true, accessKey: access.accessKey,
      fetcher: async () => Response.json({ code: 401, msg: token }) });
    assert.deepEqual(qr, { state: 'unavailable' });
  }
  for (const data of [null, {}, { accessKey: 'invalid' }]) {
    await assert.rejects(acquirePushplusTestAccess({ token, secretKey: token,
      fetcher: async () => Response.json({ code: 200, data }) }));
  }
});
test('开放接口故障只输出固定原因，不暴露服务端正文；兼容文档的两种过期字段', async () => {
  for (const [code, expected] of [[403, /公网 IP/], [401, /开放接口/]]) {
    let caught;
    try { await acquirePushplusTestAccess({ token, secretKey: token, fetcher: async () => Response.json({ code, msg: token }) }); }
    catch (error) { caught = error; }
    assert.match(reminderProbeFailureHint(caught), expected);
    assert.ok(!reminderProbeFailureHint(caught).includes(token));
  }
  assert.ok(!reminderProbeFailureHint(new Error(token)).includes(token));
  const result = await acquirePushplusTestAccess({ token, secretKey: 'synthetic_$special+secret#key',
    fetcher: async () => Response.json({ code: 200, data: { accessKey: token, expireIn: 300 } }) });
  assert.equal(result.expiresIn, 300);
  await assert.rejects(acquirePushplusTestAccess({ token, secretKey: token,
    fetcher: async () => Response.json({ code: 200, data: { accessKey: token, expireIn: 300, expiresIn: 600 } }) }));
});
test('本人测试明确指定 self，不携带好友或群组目标；取得的 AccessKey 不作为公开结果', async () => {
  await sendPushplusTest({ approve: true, token, self: true, fetcher: async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.to, undefined); assert.equal(body.topic, undefined);
    return Response.json({ code: 200, data: 'self_receipt' });
  } });
  await assert.rejects(sendPushplusTest({ approve: true, token, self: true, recipient }));
  assert.deepEqual(await acquirePushplusTestAccess({ token, secretKey: token, fetcher: async (url, init) => {
    assert.equal(url, 'https://www.pushplus.plus/api/common/openApi/getAccessKey');
    assert.deepEqual(JSON.parse(init.body), { token, secretKey: token });
    return Response.json({ code: 200, data: { accessKey: token, expiresIn: 1234 } });
  } }), { accessKey: token, expiresIn: 1234 });
});
test('未同意绝不请求；只发送人工内容给一个指定接收人，不广播、不重试', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, 'https://www.pushplus.plus/send');
    const body = JSON.parse(init.body);
    assert.equal(body.to, recipient);
    assert.equal(body.topic, undefined);
    assert.equal(body.channel, 'wechat');
    assert.equal(init.redirect, 'error');
    assert.match(body.content, /人工测试/);
    return Response.json({ code: 200, data: 'receipt_1' });
  };
  await assert.rejects(sendPushplusTest({ token, recipient, fetcher }));
  assert.equal(calls, 0);
  assert.deepEqual(await sendPushplusTest({ approve: true, token, recipient, fetcher }), { state: 'accepted', receipt: 'receipt_1' });
  assert.equal(calls, 1);
});
test('请求失败视为结果未知，不泄露异常或重发；受理不等于发送成功', async () => {
  let calls = 0;
  const outcome = await sendPushplusTest({ approve: true, token, recipient, fetcher: async () => { calls++; throw new Error(token); } });
  assert.deepEqual(outcome, { state: 'unknown' });
  assert.equal(calls, 1);
  assert.deepEqual(await queryPushplusTest({ accessKey: token, receipt: 'r', fetcher: async () => Response.json({ code: 200, data: { status: 2 } }) }), { state: 'channel_reported_sent' });
});
test('扫码为单次短期且不宣称绑定完成；拒绝外部二维码地址', async () => {
  const fake = async (url, init) => {
    assert.match(url, /second=300&scanCount=1$/);
    assert.equal(init.headers['access-key'], token);
    return Response.json({ code: 200, data: { qrCodeImgUrl: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=synthetic' } });
  };
  const qr = await createPushplusTestQr({ approve: true, accessKey: token, fetcher: fake });
  assert.equal(qr.binding_verified, false);
  assert.equal(qr.state, 'qr_created');
  assert.deepEqual(await createPushplusTestQr({ approve: true, accessKey: token, fetcher: async () => Response.json({ code: 200, data: { qrCodeImgUrl: 'https://other.invalid/' } }) }), { state: 'unavailable' });
});
test('人工日历仅含一个 UTC 截止节点与提前五分钟的测试闹钟', () => {
  const text = buildCalendarProbe(Date.parse('2026-10-10T09:00:00Z'));
  assert.match(text, /DTSTART:20261010T091000Z\r\n/);
  assert.match(text, /TRIGGER:-PT5M/);
  assert.equal(text.split('BEGIN:VEVENT').length - 1, 1);
  assert.ok(!text.includes('DTEND:'));
  assert.ok(!text.includes('http'));
  assert.ok(!text.replaceAll('\r\n', '').includes('\n'));
  assert.ok(text.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75));
});
