// One explicitly approved, bounded identity-monitor experiment. No DB or intake.
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { WechatIdentitySession } from '../../apps/server/src/ingest/wechat-identity-session.js';
import { WechatIdentityChannel } from '../../apps/server/src/ingest/wechat-identity-channel.js';
import { wechatIdentityRuntime, wechatPythonArgs } from '../../apps/server/src/ingest/wechat-python.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { root: { type: 'string' }, comparison: { type: 'string' },
    'expect-revocation': { type: 'boolean' },
    'approve-identity-read': { type: 'boolean' } } });
  if (!values.root || !values.comparison || values['approve-identity-read'] !== true) throw new Error();
  const source = await open(values.comparison, 'r');
  let expected: string;
  try {
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error();
    const item: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
    const account = (item as { expected_account?: unknown })?.expected_account;
    if (typeof account !== 'string' || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(account)) throw new Error();
    expected = account;
  } finally { await source.close(); }
  const runtime = wechatIdentityRuntime(values.root);
  const expectsRevocation = values['expect-revocation'] === true;
  const sampleLimit = expectsRevocation ? 192 : 64;
  const observationMs = expectsRevocation ? 90_000 : 30_000;
  let samples = 0, maximumSampleMs = 0, revoked = false, matched = false;
  let revocationReason: string | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let duration: ReturnType<typeof setTimeout> | undefined;
  const session = new WechatIdentitySession({ root: values.root,
    onVerified: (account) => {
      matched = account === expected;
      if (!matched) { finish(); throw new Error(); }
      // Start the human-action window only after the first bounded sample succeeded.
      if (expectsRevocation) console.log(JSON.stringify({ stage: 'identity_monitor_ready',
        expected_account_matched: true, action_window_seconds: 90, login_verified: false }));
      duration = setTimeout(finish, observationMs);
    },
    onRevoked: (_account, _key, reason) => { revoked = true; revocationReason = reason; finish(); },
    createChannel: (invalidated) => {
      const channel = new WechatIdentityChannel({ executable: runtime.executable,
        args: wechatPythonArgs(runtime.entry, ['--discover', '--approve-identity-read']), onInvalidated: invalidated });
      return { current: () => channel.current(), isCurrent: (item) => channel.isCurrent(item),
        close: () => channel.close(), sample: async () => {
          if (++samples > sampleLimit) throw new Error('IDENTITY_PROBE_SAMPLE_LIMIT');
          const started = performance.now();
          const evidence = await channel.sample();
          maximumSampleMs = Math.max(maximumSampleMs, performance.now() - started);
          return evidence;
        } };
    } });
  let expired = false;
  const watchdog = setTimeout(() => { expired = true; finish(); void session.close(); }, expectsRevocation ? 120_000 : 55_000);
  let observed = false;
  try {
    await session.start(true);
    await done;
    observed = matched && !expired && samples > 1 && samples <= sampleLimit
      && (expectsRevocation ? revoked && revocationReason !== 'manual_close' : !revoked);
  } finally {
    clearTimeout(watchdog); clearTimeout(duration);
    await session.close();
  }
  console.log(JSON.stringify({ stage: observed ? (expectsRevocation ? 'identity_revocation_observed' : 'identity_monitor_observed') : 'stopped',
    expected_account_matched: matched, monitored_seconds: observed && !expectsRevocation ? 30 : null,
    revocation_reason: expectsRevocation ? revocationReason : null,
    sample_count: samples, maximum_sample_ms: Math.round(maximumSampleMs),
    worker_closed: true, login_verified: false }));
  if (!observed) process.exitCode = 2;
}
main().catch(() => {
  console.log(JSON.stringify({ stage: 'stopped', reason: 'IDENTITY_MONITOR_PROBE_FAILED', login_verified: false }));
  process.exitCode = 2;
});
