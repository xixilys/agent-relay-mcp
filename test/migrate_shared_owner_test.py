import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('migration', Path(__file__).resolve().parents[1] / 'scripts/migrate-shared-owner.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.backup = self.root / 'backup'

    def database(self, name, sql):
        path = self.state / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.executescript(sql)
        return path

    def test_conflicting_subscription_identity_rejects_before_backup_or_mutation(self):
        path = self.database('events.sqlite', '''
            CREATE TABLE event_subscriptions(id TEXT PRIMARY KEY,owner TEXT,name TEXT,callback_url TEXT,arguments_json TEXT);
            INSERT INTO event_subscriptions VALUES ('old-a','alice','peer.message','https://callback.example/hook','{"peerId":"dot","generation":1}');
            INSERT INTO event_subscriptions VALUES ('old-b','bob','peer.message','https://callback.example/hook','{"generation":1,"peerId":"dot"}');
        ''')
        with self.assertRaisesRegex(RuntimeError, 'Conflicting subscription'):
            migration.migrate(self.state, self.backup)
        self.assertFalse(self.backup.exists())
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('SELECT owner FROM event_subscriptions ORDER BY id').fetchall(), [('alice',), ('bob',)])

    def test_live_gateway_lock_rejects_before_mutation(self):
        lock = self.state / 'direct.lock'
        lock.mkdir()
        (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid()}))
        with self.assertRaisesRegex(RuntimeError, 'Gateway lock is still live'):
            migration.migrate(self.state, self.backup)
        self.assertFalse(self.backup.exists())

    def test_receipts_and_subscription_ids_survive_with_legacy_revocation_provenance(self):
        events = self.database('events.sqlite', '''
            CREATE TABLE event_subscriptions(id TEXT PRIMARY KEY,owner TEXT,name TEXT,callback_url TEXT,arguments_json TEXT);
            INSERT INTO event_subscriptions VALUES ('original-subscription','alice','peer.message','https://callback.example/hook','{"peerId":"dot"}');
        ''')
        direct = self.database('direct.sqlite', '''
            CREATE TABLE direct_commands(command_id TEXT PRIMARY KEY,request_id TEXT,owner TEXT,fingerprint TEXT,state TEXT);
            INSERT INTO direct_commands VALUES ('command','request','alice','original-fingerprint','unknown');
        ''')
        collaboration = self.database('collaboration.sqlite', '''
            CREATE TABLE collaboration_requests(request_id TEXT PRIMARY KEY,owner TEXT,submitted_at TEXT,state TEXT);
            INSERT INTO collaboration_requests VALUES ('agent-request','alice','2026-01-01T00:00:00Z','submitted');
        ''')
        peers = self.database('peers/peers.sqlite', '''
            CREATE TABLE peer_owner_revocations(owner TEXT PRIMARY KEY,revoked_at INTEGER);
            INSERT INTO peer_owner_revocations VALUES ('alice',1767312000000);
        ''')
        row = {'owner': 'alice', 'hostId': 'mac', 'requestId': 'transfer-request', 'key': 'old-key',
               'state': 'outcome_unknown', 'fingerprint': 'unchanged-fingerprint', 'resultUnknown': True}
        receipts = self.state / 'direct-transfer-receipts.json'
        receipts.write_text(json.dumps([row]))
        migration.migrate(self.state, self.backup)
        with sqlite3.connect(events) as db:
            self.assertEqual(db.execute('SELECT id,owner FROM event_subscriptions').fetchone(), ('original-subscription', migration.SHARED))
        with sqlite3.connect(direct) as db:
            self.assertEqual(db.execute('SELECT request_id,fingerprint,state,owner,legacy_owner FROM direct_commands').fetchone(),
                             ('request', 'original-fingerprint', 'unknown', migration.SHARED, 'alice'))
        with sqlite3.connect(collaboration) as db:
            self.assertEqual(db.execute('SELECT request_id,owner,legacy_owner FROM collaboration_requests').fetchone(), ('agent-request', migration.SHARED, 'alice'))
        with sqlite3.connect(peers) as db:
            self.assertEqual(db.execute('SELECT owner,revoked_at FROM peer_owner_revocations').fetchone(), ('alice', 1767312000000))
        updated = json.loads(receipts.read_text())[0]
        self.assertEqual({k: v for k, v in updated.items() if k not in ['owner', 'key']}, {k: v for k, v in row.items() if k not in ['owner', 'key']})
        expected = hashlib.sha256(json.dumps([migration.SHARED, 'mac', 'transfer-request'], separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(updated['key'], expected)
        self.assertEqual(json.loads((self.backup / receipts.name).read_text()), [row])


if __name__ == '__main__':
    unittest.main()
