// Explicit two-child contact/identity experiment. Public output is counts only.
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { WechatIdentitySession } from '../../apps/server/src/ingest/wechat-identity-session.js';
import { readWechatCatalog, wechatCatalogFailureCode } from '../../apps/server/src/ingest/wechat-catalog-channel.js';
import { WechatGroupSelection, type WechatReadContext } from '../../apps/server/src/ingest/wechat-group-selection.js';
import { wechatIdentityRuntime } from '../../apps/server/src/ingest/wechat-python.js';
import { dirname, join } from 'node:path';
import { parseWechatCatalogMetadata } from '../../apps/server/src/ingest/wechat-metadata.js';

let phase = 'prepare';
let identityRevoked = false;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { root: { type: 'string' }, metadata: { type: 'string' },
    'data-root': { type: 'string' },
    'approve-identity-read': { type: 'boolean' }, 'approve-key-read': { type: 'boolean' },
    'approve-contact-read': { type: 'boolean' } } });
  if (!values.root || !values.metadata || !values['approve-identity-read']
      || !values['approve-key-read'] || !values['approve-contact-read']) throw new Error();
  const file = await open(values.metadata, 'r');
  let metadata: Record<string, unknown>;
  try {
    const buffer = Buffer.alloc(16385); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error();
    metadata = parseWechatCatalogMetadata(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await file.close(); }
  const expected = metadata.expected_account, target = metadata.target_group;
  if (typeof expected !== 'string' || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(expected)
      || typeof target !== 'string' || !target.trim() || Buffer.byteLength(target) > 1024) throw new Error();
  const ownedMetadata = { ...metadata }; delete ownedMetadata.target_group;
  const runtime = wechatIdentityRuntime(values.root);
  let account: string | null = null;
  const cancellation = new AbortController();
  const session = new WechatIdentitySession({ root: values.root,
    onVerified: (observed) => { if (observed !== expected) throw new Error(); account = observed; },
    onRevoked: (_account, _source, reason) => { account = null; if (reason !== 'manual_close') identityRevoked = true; cancellation.abort(); },
  });
  const current = (): WechatReadContext | null => account !== null && session.verifies(account)
    ? { account, connectionId: session.sourceKey, epoch: 'catalog-probe-only' } : null;
  const watchdog = setTimeout(() => { cancellation.abort(); void session.close(); }, 150000);
  let result;
  try {
    phase = 'identity_start';
    await session.start(true);
    const context = current(); if (!context) throw new Error();
    phase = 'catalog_read';
    const groups = await readWechatCatalog({ executable: runtime.executable,
      entry: join(dirname(runtime.entry), 'catalog_worker.py'), context,
      ...(values['data-root'] ? { dataRoot: values['data-root'] } : { metadata: ownedMetadata }),
      approveContactRead: true, approveKeyRead: true, signal: cancellation.signal,
      proof: async () => account !== null && await session.revalidate(account) ? current() : null });
    phase = 'group_selection';
    const selection = new WechatGroupSelection(current);
    const offer = selection.publish(context, groups);
    const matching = offer.groups.filter((group) => group.name === target);
    // Merely validate the isolated scope. No collector, DB, cursor, AI or UI action.
    const selected = matching.length === 1 ? selection.select(offer.catalog_id, context.epoch, [matching[0]!.group_id]) : null;
    result = { stage: 'private_catalog_channel_observed', group_count: groups.length,
      target_matches: matching.length, target_unique: matching.length === 1,
      isolated_selection_checked: selected?.groups.length === 1, workers_closed: true, login_verified: false };
    selection.clear();
  } finally { clearTimeout(watchdog); await session.close(); }
  console.log(JSON.stringify(result));
}
main().catch((error: unknown) => {
  console.log(JSON.stringify({ stage: 'stopped', phase, reason: wechatCatalogFailureCode(error),
    identity_revoked: identityRevoked, login_verified: false }));
  process.exitCode = 2;
});
