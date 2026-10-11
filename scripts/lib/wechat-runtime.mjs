// Explicit source allowlist. Never recursively copy a research/data directory.
import { cpSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const WECHAT_IDENTITY_FILES = Object.freeze([
  'identity_worker.py', 'identity_discovery.py', 'identity_snapshot.py',
  'identity_calibration_probe.py', 'account_candidate.py', 'managed_windows.py',
  'native.py', 'reader.py', 'cng.py', 'window_observation.py',
  'static_type_probe.py', 'static_types.py', 'static_window_map.py', 'window_map_snapshot.py',
  'catalog_worker.py', 'catalog_probe.py', 'catalog.py', 'catalog_scope.py', 'acquisition.py', 'snapshot.py',
  'message_worker.py', 'message_source.py', 'group_intake.py', 'selected_intake.py',
  'identity_bound_capture.py', 'canary.py', 'receipts.py', 'delivery.py', 'history.py', 'textdecode.py', 'zstd_package.py',
  'LICENSE-APACHE-2.0', 'NOTICE.md',
]);

export function copyWechatIdentityRuntime(repository, destination) {
  const source = join(repository, 'tools', 'wechat4-read-probe');
  // Check everything before writing; refuse symlinks/reparse links and missing files.
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) {
    throw new Error('WECHAT_RUNTIME_SOURCE_INVALID');
  }
  for (const name of WECHAT_IDENTITY_FILES) {
    const file = lstatSync(join(source, name));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('WECHAT_RUNTIME_SOURCE_INVALID');
  }
  const target = join(destination, 'tools', 'wechat4-read-probe');
  mkdirSync(target, { recursive: true });
  for (const name of WECHAT_IDENTITY_FILES) cpSync(join(source, name), join(target, name));
  return target;
}
