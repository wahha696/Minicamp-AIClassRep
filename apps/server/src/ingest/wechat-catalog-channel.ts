import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { wechatPythonArgs, wechatPythonEnv } from './wechat-python.js';
import type { WechatGroup, WechatReadContext } from './wechat-group-selection.js';
import { encodeWechatCatalogMetadata } from './wechat-metadata.js';

interface Options {
  executable: string;
  entry: string;
  metadata?: Record<string, unknown>;
  dataRoot?: string;
  context: WechatReadContext;
  approveContactRead: boolean;
  approveKeyRead: boolean;
  signal: AbortSignal;
  proof(): Promise<WechatReadContext | null>;
  onNickname?(nickname: string | null): void;
  launch?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
}
const groups = z.array(z.object({ group_id: z.string().regex(/^[\w-]+@chatroom$/),
  name: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 1024).nullable() }).strict()).max(10000)
  .refine((rows) => new Set(rows.map((row) => row.group_id)).size === rows.length);
const workerFailure = z.enum([
  'ACCOUNT_ANCHOR_AMBIGUOUS',
  'ACCOUNT_ANCHOR_CHANGED',
  'ACCOUNT_ANCHOR_NOT_FOUND',
  'ACCOUNT_ANCHOR_OUTSIDE_MODULE',
  'ACCOUNT_MISMATCH',
  'ACCOUNT_OBSERVATION_BYTE_BUDGET_EXCEEDED',
  'ACCOUNT_OBSERVATION_TIME_EXCEEDED',
  'ACCOUNT_POINTER_INVALID',
  'ACCOUNT_ROOT_CHANGED',
  'ACCOUNT_ROOT_MISMATCH',
  'ACCOUNT_ROOT_REDIRECTED',
  'ACCOUNT_STRING_INVALID',
  'ACCOUNT_STRING_LAYOUT_UNSUPPORTED',
  'ACCOUNT_VALUE_CHANGED',
  'AES256_KEY_LENGTH',
  'AES_BLOCK_LENGTH',
  'AES_OUTPUT_LENGTH',
  'BATCH_LIMIT',
  'BATCH_NOT_ACKNOWLEDGED',
  'CATALOG_CAPTURE_FAILED',
  'CATALOG_STATIC_ANALYSIS_FAILED',
  'CIPHER_MARKER_NOT_FOUND',
  'CONTACT_CAPTURE_SCOPE_MISMATCH',
  'CONTACT_CATALOG_GROUP_LIMIT',
  'CONTACT_CATALOG_QUERY_FAILED',
  'CONTACT_GROUP_ID_INVALID_OR_DUPLICATE',
  'CONTACT_GROUP_NAME_INVALID_OR_LIMIT',
  'CONTACT_IMAGE_BUDGET_OR_TYPE_INVALID',
  'CONTACT_METADATA_CONFIRMATION_REQUIRED',
  'CONTACT_PROBE_IDENTITIES_INVALID',
  'CONTACT_PROBE_METADATA_INVALID',
  'CONTACT_PROBE_SELECTION_INVALID',
  'CONTACT_SCHEMA_UNSUPPORTED',
  'CONTACT_SCOPE_ACCOUNT_AMBIGUOUS',
  'CONTACT_SCOPE_ACCOUNT_NOT_FOUND',
  'CONTACT_SCOPE_ACCOUNT_REDIRECTED',
  'CONTACT_SCOPE_BUDGET_INVALID',
  'CONTACT_SCOPE_ENTRY_LIMIT',
  'CONTACT_SCOPE_FILE_CHANGED',
  'CONTACT_SCOPE_FILE_LIMIT',
  'CONTACT_SCOPE_METADATA_CONSENT_REQUIRED',
  'CONTACT_SCOPE_PROFILE_UNSUPPORTED',
  'CONTACT_SCOPE_ROOT_CHANGED',
  'CONTACT_SCOPE_ROOT_REDIRECTED',
  'CONTACT_SCOPE_SELECTION_INVALID',
  'CONTACT_SCOPE_TIME_EXCEEDED',
  'CURSOR_INVALID',
  'DB_FINAL_PATH_MISMATCH',
  'DB_GENERATION_CHANGED',
  'DECODED_PAGE_SIZE',
  'EXPLICIT_ACCOUNT_OBSERVATION_BUDGET_REQUIRED',
  'EXPLICIT_ACCOUNT_PROFILE_AND_IDENTITIES_REQUIRED',
  'EXPLICIT_ACCOUNT_REQUIRED',
  'EXPLICIT_ACCOUNT_SELECTION_REQUIRED',
  'EXPLICIT_ALL_CURSORS_REQUIRED',
  'EXPLICIT_CONTACT_CATALOG_BUDGET_REQUIRED',
  'EXPLICIT_CONTACT_IDENTITIES_REQUIRED',
  'EXPLICIT_DATABASE_IDENTITIES_AND_VFS_REQUIRED',
  'EXPLICIT_EXPERIMENTAL_CIPHER_PROFILE_REQUIRED',
  'EXPLICIT_JOINT_ANCHOR_REQUIRED',
  'EXPLICIT_JOINT_IDENTITY_BUDGET_REQUIRED',
  'EXPLICIT_MANAGED_PROCESS_REQUIRED',
  'EXPLICIT_MANAGED_WINDOW_BUDGET_REQUIRED',
  'EXPLICIT_MODULE_AMBIGUOUS',
  'EXPLICIT_MODULE_MISSING',
  'EXPLICIT_PID_REQUIRED',
  'EXPLICIT_RELATIVE_DB_REQUIRED',
  'EXPLICIT_SCAN_BUDGET_REQUIRED',
  'EXPLICIT_SELECTED_FIRST_PAGES_REQUIRED',
  'EXPLICIT_SHARD_MANIFEST_REQUIRED',
  'EXPLICIT_UNIQUE_GROUPS_REQUIRED',
  'EXPLICIT_VERIFIED_PROCESS_IDENTITY_REQUIRED',
  'EXPLICIT_VFS_PROFILE_REQUIRED',
  'EXPLICIT_WINDOW_MAPPER_REQUIRED',
  'EXPLICIT_WINDOW_MAP_BUDGET_REQUIRED',
  'EXPLICIT_WINDOW_MAP_TARGETS_REQUIRED',
  'FILE_CLOSE_FAILED',
  'FILE_METADATA_FAILED',
  'FILE_OPEN_READ_FAILED',
  'FILE_OR_DIRECTORY_TYPE_MISMATCH',
  'FILE_READ_BOUNDS',
  'FILE_SEEK_FAILED',
  'FILE_SHORT_READ',
  'FINAL_PATH_FAILED',
  'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT',
  'IMMUTABLE_SNAPSHOT_REQUIRED',
  'JOINT_ACCOUNT_CHANGED',
  'JOINT_IDENTITY_BYTE_LIMIT',
  'JOINT_IDENTITY_CONFIRMATION_REQUIRED',
  'JOINT_IDENTITY_TIME_EXCEEDED',
  'JOINT_PROCESS_OR_MODULE_CHANGED',
  'JOINT_WINDOW_STATE_CHANGED',
  'KEY_CLOSED',
  'KEY_MARKER_HIT_LIMIT',
  'KEY_PENDING_REFERENCE_LIMIT',
  'KEY_REFERENCE_HIT_LIMIT',
  'KEY_SCAN_BYTE_BUDGET_EXCEEDED',
  'KEY_SCAN_CANDIDATE_LIMIT',
  'KEY_SCAN_TIME_EXCEEDED',
  'LOCAL_ABSOLUTE_PATH_REQUIRED',
  'MAIN_SIZE_OR_BUDGET',
  'MANAGED_PROCESS_OR_MODULE_CHANGED',
  'MANAGED_RUNTIME_PROFILE_CHANGED',
  'MANAGED_STATIC_PROFILE_INVALID',
  'MANAGED_TARGET_WINDOW_SET_INVALID',
  'MANAGED_WINDOW_BUDGET_EXCEEDED',
  'MANAGED_WINDOW_BYTE_LIMIT',
  'MANAGED_WINDOW_CONFIRMATION_REQUIRED',
  'MANAGED_WINDOW_OWNER_CHANGED',
  'MANAGED_WINDOW_SET_CHANGED',
  'MANAGED_WINDOW_SHORT_READ',
  'MANAGED_WINDOW_TIME_EXCEEDED',
  'MESSAGE_CURSOR_NOT_UNIQUE',
  'MESSAGE_SCHEMA_UNSUPPORTED',
  'MESSAGE_TABLE_UNSUPPORTED',
  'NATIVE_FILE_IDENTITY_REQUIRED',
  'NO_CIPHER_CANDIDATES',
  'PAGE_AUTHENTICATION_FAILED',
  'PAGE_SIZE_OR_NUMBER',
  'PROCESS_CHANGED_OR_EXITED',
  'PROCESS_CLOSE_FAILED',
  'PROCESS_IDENTITY_CHANGED',
  'PROCESS_MODULE_CLOSE_FAILED',
  'PROCESS_MODULE_IDENTITY_CHANGED',
  'PROCESS_MODULE_METADATA_FAILED',
  'PROCESS_PATH_OR_VERSION_MISMATCH',
  'PROCESS_READ_ACCESS_FAILED',
  'PROCESS_READ_BOUNDS',
  'PROCESS_REGION_ENUMERATION_FAILED',
  'PROCESS_REGION_INVALID',
  'PROCESS_SHORT_READ',
  'PROCESS_VERSION_FAILED',
  'READ_ALREADY_RUNNING',
  'REAL_READ_SCOPE_CONFIRMATION_REQUIRED',
  'RUNTIME_ACCOUNT_READ_CONFIRMATION_REQUIRED',
  'SELECTED_DB_KEY_MISSING_OR_AMBIGUOUS',
  'SELECTED_GROUP_NOT_FOUND',
  'SHARD_GENERATION_CHANGED',
  'SHARD_MANIFEST_MISMATCH',
  'SNAPSHOT_LIMIT',
  'SNAPSHOT_LOCK_BUSY',
  'SNAPSHOT_MISSING_PAGE',
  'SNAPSHOT_SIZE_OR_BUDGET',
  'SNAPSHOT_SOURCE_CHANGED',
  'SNAPSHOT_TIME_EXCEEDED',
  'SNAPSHOT_TIME_LIMIT',
  'SNAPSHOT_TOTAL_BUDGET_EXCEEDED',
  'SNAPSHOT_UNLOCK_FAILED',
  'SOURCE_WAL_MODE_REQUIRED',
  'SQLITE_CLOSED',
  'SQLITE_DESERIALIZE_REQUIRED',
  'SQLITE_HEADER_UNSUPPORTED',
  'SQLITE_INTEGRITY_FAILED',
  'SQLITE_MODE_UNSUPPORTED',
  'SQLITE_QUERY_FAILED',
  'SQLITE_SNAPSHOT_OPEN_FAILED',
  'TARGET_X64_REQUIRED',
  'UNSUPPORTED_CIPHER_LAYOUT',
  'UNSUPPORTED_PLAINTEXT_HEADER',
  'WAL_CHECKSUM_INPUT',
  'WAL_COMMIT_BOUNDS',
  'WAL_COMMIT_INDEX_MISMATCH',
  'WAL_FORMAT_UNSUPPORTED',
  'WAL_FRAME_CHECKSUM',
  'WAL_GENERATION_MISMATCH',
  'WAL_HEADER_CHECKSUM',
  'WAL_INDEX_BUSY_OR_INVALID',
  'WAL_INDEX_CHECKSUM',
  'WAL_INDEX_GENERATION_MISMATCH',
  'WAL_INDEX_UNSUPPORTED',
  'WAL_PAGE_BOUNDS',
  'WAL_PARTIAL_FRAME',
  'WAL_SIZE',
  'WINDOWS_CNG_FAILED',
  'WINDOWS_CNG_REQUIRED',
  'WINDOWS_X64_REQUIRED',
  'WINDOW_MAP_BYTE_LIMIT',
  'WINDOW_MAP_CHANGED',
  'WINDOW_MAP_CODE_CHANGED',
  'WINDOW_MAP_CYCLE_OR_ALIAS',
  'WINDOW_MAP_DUPLICATE_KEY',
  'WINDOW_MAP_DUPLICATE_OBJECT',
  'WINDOW_MAP_HASH_INVALID',
  'WINDOW_MAP_HWND_MISMATCH',
  'WINDOW_MAP_LAYOUT_INVALID',
  'WINDOW_MAP_NODE_LIMIT',
  'WINDOW_MAP_OBJECT_DESTROYING',
  'WINDOW_MAP_OBJECT_OWNERSHIP_INVALID',
  'WINDOW_MAP_POINTER_INVALID',
  'WINDOW_MAP_SHORT_READ',
  'WINDOW_MAP_TIME_EXCEEDED',
]);
const safeErrors = new Set(['WECHAT_CATALOG_CONSENT_REQUIRED', 'WECHAT_CATALOG_NOT_CURRENT',
  'WECHAT_SELECTION_NOT_CURRENT', 'WECHAT_SELECTION_STATE_INVALID', 'WECHAT_SELECTION_SAVE_FAILED',
  'WECHAT_SELECTION_LIMIT', 'WECHAT_SELECTION_GROUP_CONFLICT', 'WECHAT_SELECTION_OUTER_TRANSACTION',
  'WECHAT_CATALOG_METADATA_INVALID',
  'WECHAT_CATALOG_REQUEST_LIMIT', 'WECHAT_CATALOG_WORKER_FAILED', 'WECHAT_CATALOG_TIMEOUT',
  'WECHAT_CATALOG_RESULT_LIMIT', 'WECHAT_CATALOG_RESULT_INVALID',
  ...workerFailure.options.map((reason) => `WECHAT_CATALOG_${reason}`)]);
export function wechatCatalogFailureCode(error: unknown): string {
  return error instanceof Error && safeErrors.has(error.message) ? error.message : 'WECHAT_CATALOG_WORKER_FAILED';
}

function same(a: WechatReadContext | null, b: WechatReadContext): boolean {
  return a !== null && a.account === b.account && a.connectionId === b.connectionId && a.epoch === b.epoch;
}

export function validWechatDataRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
    && /^[A-Za-z]:[\\/]/.test(value)
    && win32.basename(win32.normalize(value)).toLowerCase() === 'xwechat_files';
}

/** One owned catalog child, with no public listener or auto-start. Caller cancels
 * when its live connection is revoked and obtains fresh proof around the job.
 * No status response, stderr, native path or group list is logged.
 */
export async function readWechatCatalog(options: Options): Promise<WechatGroup[]> {
  if (options.approveContactRead !== true || options.approveKeyRead !== true) throw new Error('WECHAT_CATALOG_CONSENT_REQUIRED');
  if (Boolean(options.metadata) === (options.dataRoot !== undefined)) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
  if (options.dataRoot !== undefined && !validWechatDataRoot(options.dataRoot)) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
  if (options.signal.aborted || (options.metadata && options.metadata.expected_account !== options.context.account)
      || !same(await options.proof(), options.context) || options.signal.aborted) throw new Error('WECHAT_CATALOG_NOT_CURRENT');
  const token = randomBytes(32).toString('hex');
  const selection = options.metadata ? { command: 'catalog', metadata: encodeWechatCatalogMetadata(options.metadata) }
    : { command: 'catalog_root', selection: { data_root: options.dataRoot, expected_account: options.context.account } };
  const request = Buffer.from(`${JSON.stringify({ v: 1, token, seq: 0, ...selection })}\n`);
  if (request.length > 16384) throw new Error('WECHAT_CATALOG_REQUEST_LIMIT');
  const args = wechatPythonArgs(options.entry, ['--approve-identity-read', '--approve-key-read', '--approve-contact-read']);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.launch ?? ((exe, argv) => spawn(exe, argv, { windowsHide: true, shell: false,
      env: wechatPythonEnv(), stdio: ['pipe', 'pipe', 'pipe'] })))(options.executable, args);
  } catch { throw new Error('WECHAT_CATALOG_WORKER_FAILED'); }
  let error: string | null = null, length = 0;
  const chunks: Buffer[] = [];
  const fail = (code: string) => {
    if (error !== null) return;
    error = code; chunks.length = 0;
    child.stdin.destroy(); child.kill(); // Our worker only; never WeChat.
  };
  const abort = () => fail('WECHAT_CATALOG_NOT_CURRENT');
  const timeout = setTimeout(() => fail('WECHAT_CATALOG_TIMEOUT'), 120000);
  timeout.unref();
  try {
    const exit = new Promise<number | null>((resolve) => {
      child.once('close', (code: number | null) => resolve(code));
      child.once('error', () => fail('WECHAT_CATALOG_WORKER_FAILED'));
      child.stdin.on('error', () => fail('WECHAT_CATALOG_WORKER_FAILED'));
      child.stdout.on('error', () => fail('WECHAT_CATALOG_WORKER_FAILED'));
      child.stderr.on('error', () => fail('WECHAT_CATALOG_WORKER_FAILED'));
      child.stdout.on('data', (value: Buffer) => {
        if (error !== null) return;
        if (!Buffer.isBuffer(value) || (length += value.length) > 1048576) { fail('WECHAT_CATALOG_RESULT_LIMIT'); return; }
        chunks.push(value);
      });
      child.stderr.resume();
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    else child.stdin.end(request);
    const code = await exit; // A result is never returned before this worker is reaped.
    if (error !== null) throw new Error(error);
    if (code !== 0) {
      let reason = 'WECHAT_CATALOG_WORKER_FAILED';
      if (code === 2) {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
          const failure = z.object({ v: z.literal(1), token: z.literal(token), seq: z.literal(0),
            kind: z.literal('error'), reason: workerFailure }).strict().parse(parsed);
          reason = `WECHAT_CATALOG_${failure.reason}`;
        } catch { /* No raw stderr, unknown error values or unowned result. */ }
      }
      throw new Error(reason);
    }
    let result: WechatGroup[];
    let nickname: string | null = null;
    try {
      const response: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
      const item = z.object({ v: z.literal(1), token: z.literal(token), seq: z.literal(0), kind: z.literal('catalog'), groups,
        nickname: z.string().max(1024).refine(v => !v.includes('\0') && Buffer.byteLength(v) <= 1024).nullable().optional() }).strict().parse(response);
      result = item.groups;
      nickname = item.nickname?.trim() || null;
    } catch { throw new Error('WECHAT_CATALOG_RESULT_INVALID'); }
    if (options.signal.aborted || !same(await options.proof(), options.context) || options.signal.aborted) {
      throw new Error('WECHAT_CATALOG_NOT_CURRENT');
    }
    options.onNickname?.(nickname);
    return result;
  } finally {
    clearTimeout(timeout); options.signal.removeEventListener('abort', abort);
    chunks.length = 0;
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
}
