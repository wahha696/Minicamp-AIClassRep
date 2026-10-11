const unsigned64 = /^(?:0|[1-9][0-9]{0,19})$/;
const maximum = (1n << 64n) - 1n;

function token(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
    return String(value);
  }
  if (typeof value !== 'string' || !unsigned64.test(value) || BigInt(value) > maximum) {
    throw new Error('WECHAT_CATALOG_METADATA_INVALID');
  }
  return value;
}

/** Preserve native 64-bit identities through JSON. Never guess an already
 * rounded JS number. Python decodes canonical decimal strings back to integers.
 */
export function encodeWechatCatalogMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out = { ...metadata };
  for (const [key, fields] of [['process', ['created']], ['module', ['base']],
    ['expected_file', ['volume', 'index', 'created']]] as const) {
    const value = out[key];
    if (value === undefined) continue; // Worker separately validates the complete schema.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
    const copy = { ...value } as Record<string, unknown>;
    for (const field of fields) copy[field] = token(copy[field]);
    out[key] = copy;
  }
  return out;
}

/** Bounded operator metadata parser. Quote only out-of-safe-range integer
 * tokens, leaving JSON strings untouched; JSON.parse still validates the syntax.
 * This is not used to accept account/PID/path fields from public HTTP clients.
 */
export function parseWechatCatalogMetadata(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf8') > 16384) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
  try {
    const lossless = raw.replace(/^\uFEFF/, '').replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (whole, number: string | undefined) => {
      if (number === undefined || !/^-?\d+$/.test(number)) return whole;
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(number)) throw new Error();
      const exact = BigInt(number);
      return exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER) ? `"${number}"` : whole;
    });
    const parsed: unknown = JSON.parse(lossless);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return encodeWechatCatalogMetadata(parsed as Record<string, unknown>);
  } catch { throw new Error('WECHAT_CATALOG_METADATA_INVALID'); }
}
