import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { db, openDb } from './db/index.js';
import { accountEpoch, initAccounts, resetCurrentWorkspaceData, restoreCurrentAccountBackup, setAccountsDirForTest, workspaceRuntime } from './accounts.js';
import { createPortableBackup, writeParsedBackup } from './data-backup.js';
import { getTimetable, saveTimetable } from './timetable.js';
import { listCourseCompletions, listCourseOccurrences, setCourseCompletion } from './course-completions.js';

let root = '';
afterEach(() => {
  if (!root) return;
  if (db.isOpen) db.close();
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  const rel = relative(realpathSync(tmpdir()), realpathSync(root));
  if (isAbsolute(rel) || !rel.startsWith('classrep-course-lifecycle-') || rel.includes('..')) throw new Error('SYNTHETIC_CLEANUP_PATH');
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
it('persists across reopen, upgrades v11, and includes completion in real portable restore and workspace reset', async () => {
  root = mkdtempSync(join(tmpdir(), 'classrep-course-lifecycle-'));
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await initAccounts({ dataDir: root, settingsDir: root, accountsDir: join(root, 'accounts'), fallbackDb: join(root, 'fallback.db'), workspace: {
    automaticWorkspace: false, verifyIdentity: () => true, stopCollectors: () => {}, restartCollectors: () => {},
  } });
  const runtime = workspaceRuntime()!;
  await runtime.observe({ platform: 'wechat', account_id: 'wxid_synthetic_course' }, 'synthetic');
  await runtime.choose({ request_id: runtime.status().pending[0]!.request_id, expected_account_epoch: accountEpoch(), choice: { mode: 'create', name: '合成课程空间' }, confirm_switch: false });
  const path = String(db.prepare('PRAGMA database_list').get()!.file);
  db.exec("DROP TABLE course_completions; UPDATE kv SET value='11' WHERE key='schema_version'");
  openDb(path);
  expect(db.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value).toBe('12');
  saveTimetable({ semester_start: '2026-09-07', courses: [{ id: 'synthetic', name: '合成课', teacher: '', location: '', weekday: 1, block: 1, weeks: [1] }] });
  const o = listCourseOccurrences('2026-09-07', '2026-09-08').occurrences[0]!;
  setCourseCompletion({ occurrence_id: o.occurrence_id, date: o.date, expected_start: o.start, expected_end: o.end, expected_revision: getTimetable().revision!, done: true });
  openDb(path);
  expect(listCourseCompletions('2026-09-07', '2026-09-08').completions).toHaveLength(1);
  const backup = createPortableBackup();
  await resetCurrentWorkspaceData(accountEpoch(), async () => {});
  expect(db.prepare('SELECT COUNT(*) AS n FROM course_completions').get()?.n).toBe(0);
  expect(getTimetable().courses).toEqual([]);
  const candidate = join(dirname(path), '.synthetic-course-restore.db');
  writeParsedBackup(backup, candidate);
  expect((await restoreCurrentAccountBackup(accountEpoch(), candidate)).status).toBe('restored');
  expect(listCourseCompletions('2026-09-07', '2026-09-08').completions).toHaveLength(1);
}, 15_000);
