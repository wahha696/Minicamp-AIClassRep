import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import { WechatSelectionStore } from './wechat-selection-store.js';
import { wechatGroupId } from './wechat.js';
import type { WechatReadContext } from './wechat-group-selection.js';

const account = 'wxid_synthetic_selection';
const a = { group_id: 'a@chatroom', name: '同名群' };
const b = { group_id: 'b@chatroom', name: '同名群' };
const available = [a.group_id, b.group_id];
const folders: string[] = [];
function fixture() {
  const context = { account, epoch: 'synthetic-epoch', connectionId: randomUUID() };
  let current: WechatReadContext | null = context;
  const store = new WechatSelectionStore('synthetic-space', account, () => current);
  return { context, store, apply: (groups: typeof a[]) => store.apply({ ...context, groups }, available),
    current: (value: WechatReadContext | null) => { current = value; } };
}
afterEach(() => {
  if (db?.isOpen) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('durable per-group desired selection, synthetic workspace only', () => {
  it('reopening retains two independent activation tokens and unchanged selection never resets either', () => {
    const folder = mkdtempSync(join(tmpdir(), 'classrep-selection-')); folders.push(folder);
    const file = join(folder, 'synthetic.db'); openDb(file);
    const f = fixture(); f.apply([a, b]);
    const first = f.store.list();
    expect(first.map((row) => row.pending)).toEqual(['first', 'first']);
    expect(first[0]!.activation_id).not.toBe(first[1]!.activation_id);
    f.store.activated(f.context, a.group_id, first[0]!.activation_id);
    f.apply([a, b]);
    const saved = f.store.list(); openDb(file);
    const reopened = fixture(); expect(reopened.store.list()).toEqual(saved);
    reopened.apply([b, a]);
    expect(reopened.store.list()).toEqual(saved);
    expect(() => f.store.list()).toThrow('WECHAT_SELECTION_NOT_CURRENT');
  });
  it('cancel/re-enable keeps old business rows and changes only the re-enabled activation; old completion is rejected', () => {
    openDb(':memory:'); const f = fixture(); f.apply([a, b]);
    const first = f.store.list(); const old = first[0]!.activation_id;
    f.store.activated(f.context, a.group_id, old);
    const id = wechatGroupId(account, a.group_id);
    db.prepare(`INSERT INTO messages(message_id,group_id,sender_name,text,sent_at,source,created_at)
      VALUES ('synthetic-pending',?,'member','pending',1,'wechat',1)`).run(id);
    f.apply([b]); expect(f.store.list()[0]!.enabled).toBe(false);
    expect(db.prepare('SELECT enabled FROM groups WHERE group_id=?').get(id)?.enabled).toBe(0);
    f.apply([a, b]);
    const next = f.store.list(); expect(next[0]).toMatchObject({ enabled: true, pending: 'reenable', activated: true });
    expect(next[0]!.activation_id).not.toBe(old); expect(next[1]).toEqual(first[1]);
    expect(() => f.store.activated(f.context, a.group_id, old)).toThrow('WECHAT_SELECTION_ACTIVATION_STALE');
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(1);
  });
  it('a group not yet initialized stays first activation after cancellation; empty selection stops every available group', () => {
    openDb(':memory:'); const f = fixture(); f.apply([a, b]); const old = f.store.list()[0]!.activation_id;
    f.apply([]); expect(f.store.list().every((row) => !row.enabled)).toBe(true);
    f.apply([a]); const next = f.store.list()[0]!;
    expect(next.pending).toBe('first'); expect(next.activated).toBe(false); expect(next.activation_id).not.toBe(old);
    expect(() => f.store.activated({ ...f.context, epoch: 'stale' }, a.group_id, next.activation_id)).toThrow('NOT_CURRENT');
  });
  it('a catalog omitting a remembered group does not silently cancel it when other groups are saved', () => {
    openDb(':memory:'); const f = fixture(); f.apply([a, b]);
    const before = f.store.list()[1];
    f.store.apply({ ...f.context, groups: [a] }, [a.group_id]);
    expect(f.store.list()[1]).toEqual(before);
  });
  it('an interrupted save rolls back selection, group enabled flags and names together', () => {
    openDb(':memory:'); const f = fixture(); f.apply([a]); const before = f.store.list();
    db.exec(`CREATE TRIGGER synthetic_fail BEFORE INSERT ON groups WHEN NEW.name='fail'
      BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END`);
    expect(() => f.apply([{ ...b, name: 'fail' }])).toThrow('WECHAT_SELECTION_SAVE_FAILED');
    expect(f.store.list()).toEqual(before);
    expect(db.prepare('SELECT enabled FROM groups WHERE group_id=?').get(wechatGroupId(account, a.group_id))?.enabled).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM groups').get()?.n).toBe(1);
  });
  it('wrong account, stale scope and corrupt saved state fail without overwriting old data', () => {
    openDb(':memory:'); const f = fixture(); f.apply([a]);
    const raw = db.prepare("SELECT key,value FROM kv WHERE key LIKE 'wechat_selection_v1:%'").get()!;
    f.current({ ...f.context, account: 'wxid_other' });
    expect(() => f.apply([])).toThrow('NOT_CURRENT'); f.current(f.context);
    expect(() => f.store.apply({ ...f.context, connectionId: randomUUID(), groups: [] }, available)).toThrow('NOT_CURRENT');
    db.prepare('UPDATE kv SET value=? WHERE key=?').run('invalid json', raw.key!);
    expect(() => f.apply([])).toThrow('STATE_INVALID');
    expect(db.prepare('SELECT value FROM kv WHERE key=?').get(raw.key!)?.value).toBe('invalid json');
    expect(db.prepare('SELECT enabled FROM groups WHERE group_id=?').get(wechatGroupId(account, a.group_id))?.enabled).toBe(1);
  });
});
