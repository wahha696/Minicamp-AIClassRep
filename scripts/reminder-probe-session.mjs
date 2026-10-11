// Only launched by reminder-probe.ps1. Credentials arrive through the child environment,
// are cleared immediately, and are never written to files or printed.
import { acquirePushplusTestAccess, createPushplusTestQr, queryPushplusTest, sendPushplusTest, reminderProbeFailureHint, reminderProbeFailureDiagnostic } from './lib/reminder-feasibility.mjs';
const [mode, approval, receipt] = process.argv.slice(2);
const token = process.env.CLASSREP_PROBE_PUSHPLUS_TOKEN;
const secretKey = process.env.CLASSREP_PROBE_PUSHPLUS_SECRET;
const recipient = process.env.CLASSREP_PROBE_PUSHPLUS_RECIPIENT;
for (const key of ['TOKEN', 'SECRET', 'RECIPIENT']) delete process.env[`CLASSREP_PROBE_PUSHPLUS_${key}`];
try {
  if (mode === 'SendSelf' || mode === 'SendFriend') {
    if (approval !== '--approve-test-send') throw new Error('TEST_SEND_CONSENT_REQUIRED');
    console.log(JSON.stringify(await sendPushplusTest({ approve: true, token, ...(mode === 'SendSelf' ? { self: true } : { recipient }) })));
  } else if (mode === 'Qr' || mode === 'Query') {
    if (mode === 'Qr' && approval !== '--approve-test-qr') throw new Error('TEST_QR_CONSENT_REQUIRED');
    if (mode === 'Query' && (approval !== '--approve-test-query' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt ?? ''))) throw new Error('TEST_QUERY_INVALID');
    const access = await acquirePushplusTestAccess({ token, secretKey });
    if (access.expiresIn === null) console.error('有效期字段未识别：仅立即用于本次操作，不缓存、不假定有效期；是否可用由后续接口确认。');
    console.log(JSON.stringify(mode === 'Qr'
      ? await createPushplusTestQr({ approve: true, accessKey: access.accessKey })
      : await queryPushplusTest({ accessKey: access.accessKey, receipt })));
  } else { throw new Error('TEST_MODE_INVALID'); }
} catch (error) {
  console.error(reminderProbeFailureHint(error));
  const diagnostic = reminderProbeFailureDiagnostic(error);
  if (diagnostic) console.error(`诊断：${JSON.stringify(diagnostic)}`);
  process.exitCode = 1;
}
