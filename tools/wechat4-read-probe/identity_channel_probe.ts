// One bounded private-pipe experiment. No server, DB, chat, contact or key reads.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WechatIdentityChannel } from '../../apps/server/src/ingest/wechat-identity-channel.js';
import { wechatPythonArgs } from '../../apps/server/src/ingest/wechat-python.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    metadata: { type: 'string' }, comparison: { type: 'string' }, python: { type: 'string' },
    discover: { type: 'boolean' },
    'approve-identity-read': { type: 'boolean' },
  } });
  if (!values['approve-identity-read'] || Boolean(values.metadata) === Boolean(values.discover)
      || !values.comparison || !values.python) throw new Error();
  const raw = await readFile(values.comparison);
  if (raw.length > 16384) throw new Error();
  const comparison: unknown = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  const expected = (comparison as { expected_account?: unknown })?.expected_account;
  if (typeof expected !== 'string' || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(expected)) throw new Error();
  const channel = new WechatIdentityChannel({ executable: values.python,
    args: wechatPythonArgs(fileURLToPath(new URL('./identity_worker.py', import.meta.url)),
      [...(values.discover ? ['--discover'] : ['--metadata', values.metadata!]), '--approve-identity-read']),
    onInvalidated: () => {} });
  const timeout = setTimeout(() => { void channel.close(); }, 55_000);
  let result;
  try {
    const evidence = await channel.sample();
    if (!evidence || !channel.isCurrent(evidence)) throw new Error();
    result = { stage: 'private_identity_channel_observed', account_present: true,
      expected_account_matched: evidence.account === expected, ticket_current: true,
      worker_closed: true, login_verified: false };
  } finally {
    clearTimeout(timeout);
    await channel.close();
  }
  console.log(JSON.stringify(result));
}
main().catch(() => {
  console.log(JSON.stringify({ stage: 'stopped', reason: 'IDENTITY_CHANNEL_PROBE_FAILED', login_verified: false }));
  process.exitCode = 2;
});
