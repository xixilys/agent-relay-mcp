#!/usr/bin/env python3
"""Explicit offline migration for a single user's shared OAuth authority domain.

Stop the gateway first. Backups contain private state; keep the backup directory
private. OAuth credentials are neither read nor changed. Recovery is offline,
from the saved SQLite snapshots and JSON, before restarting the old code/config.
"""
import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path

SHARED = 'local-owner:shared'


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def databases(base):
    result = []
    for directory in [base, base / 'peers', *sorted((base / 'hosts').glob('*'))]:
        for name in ['collaboration.sqlite', 'direct.sqlite', 'events.sqlite', 'peers.sqlite']:
            path = directory / name
            if path.is_file():
                result.append(path)
    return result


def inspect(base, *, offline=False):
    files = databases(base)
    aliases = {}
    for path in files:
        # After the last WAL connection closes, macOS SQLite may need to
        # recreate shared-memory sidecars even for a SELECT. mode=rw allows
        # that in an explicitly offline migration; it never creates a DB.
        db = sqlite3.connect(f'file:{path}?mode={"rw" if offline else "ro"}', uri=True)
        db.row_factory = sqlite3.Row
        try:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'event_subscriptions' in tables:
                identities = set()
                for row in db.execute('SELECT callback_url,name,arguments_json FROM event_subscriptions'):
                    identity = (row[0], row[1], canonical(json.loads(row[2])))
                    if identity in identities:
                        raise RuntimeError('Conflicting subscription identities; no state has been changed')
                    identities.add(identity)
            if 'peers' in tables:
                for row in db.execute('SELECT peer_id FROM peers GROUP BY peer_id HAVING count(*)>1'):
                    peers = list(db.execute('SELECT * FROM peers WHERE peer_id=? ORDER BY created_at,owner', (row[0],)))
                    # Only obsolete unbound test identities may be renamed.
                    if any(p['state'] != 'stopped' or p['binding_json'] or p['subscription_id'] for p in peers):
                        raise RuntimeError('Conflicting live or bound peer IDs require an explicit decision')
                    for peer in peers[1:]:
                        suffix = hashlib.sha256(peer['owner'].encode()).hexdigest()[:10]
                        alias = peer['peer_id'][:105] + '.archive-' + suffix
                        if db.execute('SELECT 1 FROM peers WHERE peer_id=?', (alias,)).fetchone():
                            raise RuntimeError('Archived peer alias already exists')
                        aliases[(peer['owner'], peer['peer_id'])] = alias
                for row in db.execute('SELECT message_id FROM peer_messages GROUP BY message_id HAVING count(*)>1'):
                    raise RuntimeError('Message UUID collision; no state has been changed')
                if db.execute('SELECT in_reply_to FROM peer_messages WHERE in_reply_to IS NOT NULL GROUP BY in_reply_to HAVING count(*)>1').fetchone():
                    raise RuntimeError('Multiple replies would conflict in the shared domain')
                if db.execute("SELECT 1 FROM peer_messages WHERE delivery_state='submitting'").fetchone():
                    raise RuntimeError('A native peer delivery is in flight')
            if 'direct_commands' in tables and db.execute("SELECT 1 FROM direct_commands WHERE state IN ('pending','running')").fetchone():
                raise RuntimeError('A Direct command is in flight')
            if 'event_outbox' in tables and db.execute("SELECT 1 FROM event_outbox WHERE state='sending'").fetchone():
                raise RuntimeError('An event callback is in flight')
        finally:
            db.close()
    transfers = base / 'direct-transfer-receipts.json'
    if transfers.exists():
        rows = json.loads(transfers.read_text())
        if any(row['state'] in ['pending', 'ready'] for row in rows):
            raise RuntimeError('A binary transfer or download is active')
        keys = [(row['hostId'], row['requestId']) for row in rows]
        if len(keys) != len(set(keys)):
            raise RuntimeError('Transfer request identity collision')
    return files, aliases


def migrate(base, backup):
    # Never alter a state directory with an active Direct gateway lock.
    for marker in base.glob('**/direct.lock/owner.json'):
        pid = json.loads(marker.read_text()).get('pid')
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise RuntimeError('Gateway lock is still live; stop the gateway first')
    files, aliases = inspect(base, offline=True)
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(backup, 0o700)
    for path in files:
        dest = backup / path.relative_to(base)
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        source = sqlite3.connect(f'file:{path}?mode=rw', uri=True)
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
        finally:
            source.close()
            target.close()
        os.chmod(dest, 0o600)
    transfer = base / 'direct-transfer-receipts.json'
    if transfer.exists():
        (backup / transfer.name).write_bytes(transfer.read_bytes())
        os.chmod(backup / transfer.name, 0o600)
    manifest = {'sharedOwner': SHARED, 'databases': [str(p.relative_to(base)) for p in files],
                'archivedPeers': [{'formerOwner': o, 'peerId': p, 'newPeerId': a} for (o, p), a in aliases.items()]}
    (backup / 'migration.json').write_text(json.dumps(manifest, indent=2) + '\n')
    os.chmod(backup / 'migration.json', 0o600)
    # Backups precede every write. Do not restart the gateway after an exception;
    # restore every listed database, not just the last one, before recovery.
    for path in files:
        db = sqlite3.connect(path)
        try:
            with db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if 'peers' in tables:
                    for (owner, old), new in aliases.items():
                        db.execute('UPDATE peers SET peer_id=? WHERE owner=? AND peer_id=?', (new, owner, old))
                    for row in db.execute('SELECT owner,message_id,body FROM peer_messages').fetchall():
                        owner, mid, body = row
                        data = json.loads(body)
                        changed = False
                        for key in ['fromPeerId', 'toPeerId']:
                            alias = aliases.get((owner, data[key]))
                            if alias:
                                data[key] = alias
                                changed = True
                        if changed:
                            db.execute('UPDATE peer_messages SET body=?,from_peer_id=?,to_peer_id=? WHERE owner=? AND message_id=?',
                                       (canonical(data), data['fromPeerId'], data['toPeerId'], owner, mid))
                if 'direct_commands' in tables:
                    cols = {r[1] for r in db.execute('PRAGMA table_info(direct_commands)')}
                    if 'legacy_owner' not in cols:
                        db.execute('ALTER TABLE direct_commands ADD COLUMN legacy_owner TEXT')
                    db.execute('UPDATE direct_commands SET legacy_owner=COALESCE(legacy_owner,owner) WHERE owner<>?', (SHARED,))
                if 'collaboration_requests' in tables:
                    cols = {r[1] for r in db.execute('PRAGMA table_info(collaboration_requests)')}
                    if 'legacy_owner' not in cols:
                        db.execute('ALTER TABLE collaboration_requests ADD COLUMN legacy_owner TEXT')
                    db.execute('UPDATE collaboration_requests SET legacy_owner=COALESCE(legacy_owner,owner) WHERE owner<>?', (SHARED,))
                for table in tables:
                    if table == 'peer_owner_revocations':
                        # Historical per-client revocations stay historical. Copying
                        # their timestamp onto the shared owner would revoke live peers.
                        continue
                    if any(row[1] == 'owner' for row in db.execute(f'PRAGMA table_info("{table}")')):
                        db.execute(f'UPDATE "{table}" SET owner=?', (SHARED,))
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Post-migration SQLite integrity check failed')
        finally:
            db.close()
    if transfer.exists():
        rows = json.loads(transfer.read_text())
        for row in rows:
            row['owner'] = SHARED
            row['key'] = hashlib.sha256(json.dumps([SHARED, row['hostId'], row['requestId']], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        temporary = transfer.with_suffix('.shared-owner.tmp')
        temporary.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
        os.chmod(temporary, 0o600)
        temporary.replace(transfer)
    return {'databaseCount': len(files), 'archivedPeerCount': len(aliases), 'owner': SHARED}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        if not args.backup_dir:
            parser.error('--apply requires a new private --backup-dir')
        print(json.dumps(migrate(args.state_dir.resolve(), args.backup_dir.resolve())))
    else:
        files, aliases = inspect(args.state_dir.resolve())
        print(json.dumps({'dryRun': True, 'databaseCount': len(files), 'archivedPeerCount': len(aliases)}))
