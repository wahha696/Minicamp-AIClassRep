"""Explicit 1/7/30-day selected-group history from supplied memory snapshots.

No server fetch, live-reader progress reset, process/file access or AI calls.
Pages use source cursor ordering but filter by timestamp. The caller captures
the same manifest anew, enforces fresh identity and persists via import_history.
"""
import hashlib
import math

from reader import Cursor, MemoryDatabase, Message, ReadError, Reader, Scope, message_event_id


def validate_history_request(days, now_seconds, limit):
    if (type(days) is not int or days not in (1, 7, 30)
            or type(now_seconds) not in (int, float) or not math.isfinite(now_seconds)
            or not 0 <= now_seconds <= (1 << 53) - 1
            or type(limit) is not int or not 1 <= limit <= 1000):
        raise ReadError('HISTORY_REQUEST_INVALID')


def history_page(scope, manifest, shards, *, days, now_seconds, after=None, limit=100, allow_missing_groups=False):
    validate_history_request(days, now_seconds, limit)
    if type(scope) is not Scope:
        raise ReadError('HISTORY_REQUEST_INVALID')
    expected = {(s, g) for s in manifest for g in scope.groups}
    progress = {(s, g): Cursor(0, 0) for s, g in expected} if after is None else dict(after)
    if set(progress) != expected or any(type(value) is not Cursor for value in progress.values()):
        raise ReadError('HISTORY_PROGRESS_INVALID')
    Reader(scope, manifest, progress)
    if not manifest or len(shards) != len(manifest) or {s.shard_id for s in shards} != set(manifest):
        raise ReadError('SHARD_MANIFEST_MISMATCH')
    for source in shards:
        scope.check_account(source.account)
        if source.generation != manifest[source.shard_id]:
            raise ReadError('SHARD_GENERATION_CHANGED')
        if type(source.image) is not bytes:
            raise ReadError('IMMUTABLE_SNAPSHOT_REQUIRED')
    start, end = max(0, int(now_seconds) - days * 86400), int(now_seconds)
    messages, found = [], set()
    for source in shards:
        with MemoryDatabase(source.image) as database:
            for group in scope.groups:
                table = 'Msg_' + hashlib.md5(group.encode('utf-8')).hexdigest()
                tables = database.query('SELECT type FROM sqlite_master WHERE name=?', (table,))
                if not tables: continue
                if len(tables) != 1 or tables[0][0] != 'table':
                    raise ReadError('MESSAGE_TABLE_UNSUPPORTED')
                found.add(group)
                cursor = progress[(source.shard_id, group)]
                rows = database.query(f'SELECT local_id,sort_seq,server_id,local_type,real_sender_id,create_time,message_content,compress_content FROM "{table}" '
                    'WHERE create_time>=? AND create_time<=? AND (sort_seq>? OR (sort_seq=? AND local_id>?)) '
                    'ORDER BY sort_seq ASC,local_id ASC LIMIT ?', (start, end, cursor.sort_seq, cursor.sort_seq, cursor.local_id, limit + 1))
                previous = cursor
                for row in rows:
                    current = Cursor(row['sort_seq'], row['local_id'])
                    server, kind, sender, timestamp = (row[key] for key in ('server_id', 'local_type', 'real_sender_id', 'create_time'))
                    if any(type(value) is not int for value in (server, kind, sender, timestamp)):
                        raise ReadError('MESSAGE_SCHEMA_UNSUPPORTED')
                    if current <= previous or current.local_id == 0:
                        raise ReadError('MESSAGE_CURSOR_NOT_UNIQUE')
                    previous = current
                    event = message_event_id(scope.account, group, source.shard_id, source.generation, server, current.local_id)
                    messages.append(Message(event, scope.account, group, source.shard_id, current, server, kind, sender, timestamp, row['message_content'], row['compress_content']))
    if found != set(scope.groups) and not allow_missing_groups: raise ReadError('SELECTED_GROUP_NOT_FOUND')
    messages.sort(key=lambda m: (m.cursor.sort_seq, m.cursor.local_id, m.shard_id, m.group))
    page = tuple(messages[:limit]); next_progress = progress.copy()
    for message in page: next_progress[(message.shard_id, message.group)] = message.cursor
    return page, next_progress, len(messages) > limit
