import { describe, expect, it } from 'vitest';
import { encodeWechatCatalogMetadata, parseWechatCatalogMetadata } from './wechat-metadata.js';

describe('lossless native catalog metadata (synthetic only)', () => {
  const timestamp = '134360728640232154';
  it('preserves Windows creation ticks and uint64 file indexes without modifying string contents', () => {
    const raw = String.raw`{"process":{"created":134360728640232154},"module":{"base":123},"expected_file":{"created":134360728640232155,"volume":1,"index":18446744073709551615},"literal":"134360728640232154 \"quoted\""}`;
    const data = parseWechatCatalogMetadata(raw);
    expect(data).toEqual({ process: { created: timestamp }, module: { base: '123' },
      expected_file: { created: '134360728640232155', volume: '1', index: '18446744073709551615' },
      literal: `${timestamp} "quoted"` });
    expect((parseWechatCatalogMetadata('{"process":{"created":"134360728640232154"}}').process as { created: string }).created).toBe(timestamp);
  });
  it('rejects already rounded numbers, fractional or noncanonical tokens and overflowing native values', () => {
    for (const created of [Number(timestamp), -1, 1.5, '01', '+1', '1e17', '-1', '18446744073709551616', true, null]) {
      expect(() => encodeWechatCatalogMetadata({ process: { created } })).toThrow('WECHAT_CATALOG_METADATA_INVALID');
    }
    expect(() => parseWechatCatalogMetadata('{"process":{"created":1.3e17}}')).toThrow();
  });
  it('still rejects invalid JSON, root arrays and oversized input rather than repairing syntax', () => {
    for (const raw of ['[]', 'null', '{"process":{"created":01}}', '{"literal":0134360728640232154}', '{"process":{"created":1},}', ' '.repeat(16385)]) {
      expect(() => parseWechatCatalogMetadata(raw)).toThrow('WECHAT_CATALOG_METADATA_INVALID');
    }
    const original = { process: { created: timestamp }, expected_account: 'wxid_synthetic' };
    const copy = encodeWechatCatalogMetadata(original); (copy.process as { created: string }).created = '2';
    expect(original.process.created).toBe(timestamp);
  });
});
