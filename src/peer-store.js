import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJSON } from './event-store.js';

export const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const peer = row => row && ({ owner: row.owner, peerId: row.peer_id, kind: row.kind,
  displayName: row.display_name, generation: row.generation, state: row.state,
  binding: row.binding_json ? JSON.parse(row.binding_json) : null, subscriptionId: row.subscription_id,
  senderIdentityAssurance: row.assurance, createdAt: row.created_at, updatedAt: row.updated_at });
const message = row => row && ({ owner: row.owner, messageId: row.message_id,
  fromPeerId: row.from_peer_id, toPeerId: row.to_peer_id, fromGeneration: row.from_generation,
  generation: row.to_generation, text: row.text, inReplyTo: row.in_reply_to,
  rootId: row.root_id, hop: row.hop, eventId: row.event_id, createdAt: row.created_at,
  senderIdentityAssurance: row.assurance, deliveryState: row.delivery_state,
  requestId: row.request_id, reason: row.reason, turnId: row.turn_id,
  eventRecorded: Boolean(row.event_recorded), processedAt: row.processed_at });

/** Owner-scoped registry and durable intent. Transactions contain no external I/O. */
export class PeerStore {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
    this.filename = join(stateDir, 'peers.sqlite');
    closeSync(openSync(this.filename, 'a', 0o600)); chmodSync(this.filename, 0o600);
    this.db = new DatabaseSync(this.filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS peers(owner TEXT NOT NULL,peer_id TEXT NOT NULL,kind TEXT NOT NULL,
        display_name TEXT,generation INTEGER NOT NULL,state TEXT NOT NULL,binding_json TEXT,
        subscription_id TEXT,assurance TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner,peer_id));
      CREATE TABLE IF NOT EXISTS peer_owner_revocations(owner TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_messages(owner TEXT NOT NULL,message_id TEXT NOT NULL,
        body TEXT NOT NULL,from_peer_id TEXT NOT NULL,to_peer_id TEXT NOT NULL,
        from_generation INTEGER NOT NULL,to_generation INTEGER NOT NULL,text TEXT NOT NULL,in_reply_to TEXT,
        root_id TEXT NOT NULL,hop INTEGER NOT NULL,event_id TEXT NOT NULL,created_at INTEGER NOT NULL,
        assurance TEXT NOT NULL,delivery_state TEXT NOT NULL,request_id TEXT,reason TEXT,turn_id TEXT,
        event_recorded INTEGER NOT NULL DEFAULT 0,processed_at INTEGER,PRIMARY KEY(owner,message_id));
      CREATE UNIQUE INDEX IF NOT EXISTS peer_event_identity ON peer_messages(event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS peer_single_reply ON peer_messages(owner,in_reply_to) WHERE in_reply_to IS NOT NULL;
      CREATE INDEX IF NOT EXISTS peer_pending ON peer_messages(delivery_state,created_at);
      CREATE TABLE IF NOT EXISTS peer_webhook_bindings(owner TEXT NOT NULL,peer_id TEXT NOT NULL,
        generation INTEGER NOT NULL,routine_id TEXT NOT NULL,url_hash TEXT NOT NULL,
        watermark INTEGER NOT NULL,created_at INTEGER NOT NULL,disabled_reason TEXT,PRIMARY KEY(owner,peer_id,generation));
      CREATE TABLE IF NOT EXISTS peer_webhook_claims(owner TEXT NOT NULL,message_id TEXT NOT NULL,
        state TEXT NOT NULL,claimed_at INTEGER NOT NULL,completed_at INTEGER,status INTEGER,reason TEXT,
        PRIMARY KEY(owner,message_id));`);
    if (!this.db.prepare('PRAGMA table_info(peer_webhook_bindings)').all().some(c => c.name === 'disabled_reason')) {
      this.db.exec('ALTER TABLE peer_webhook_bindings ADD COLUMN disabled_reason TEXT');
    }
    this.secureFiles();
  }
  secureFiles() { for (const p of [this.filename, this.filename + '-wal', this.filename + '-shm']) if (existsSync(p)) chmodSync(p, 0o600); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); this.secureFiles(); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getPeer(owner, id) { return peer(this.db.prepare('SELECT * FROM peers WHERE owner=? AND peer_id=?').get(owner,id)); }
  listPeers(owner) { return this.db.prepare('SELECT * FROM peers WHERE owner=? ORDER BY peer_id').all(owner).map(peer); }
  register(owner, { peerId, kind, displayName, binding = null, assurance = 'claimed' }, now) {
    return this.transaction(() => {
      const old = this.getPeer(owner,peerId);
      if (old?.state === 'active') {
        if (old.kind !== kind || canonicalJSON(old.binding) !== canonicalJSON(binding)) throw new Error('Peer endpoint is already registered; unregister before changing it');
        if (displayName !== undefined) this.db.prepare('UPDATE peers SET display_name=?,updated_at=? WHERE owner=? AND peer_id=?').run(displayName,now,owner,peerId);
        return { duplicate: true, peer: this.getPeer(owner,peerId) };
      }
      if (!old && this.listPeers(owner).length >= 512) throw new Error('Peer capacity reached');
      this.db.prepare(`INSERT INTO peers VALUES (?,?,?,?,?,'active',?,NULL,?,?,?)
        ON CONFLICT(owner,peer_id) DO UPDATE SET kind=excluded.kind,display_name=excluded.display_name,
          generation=excluded.generation,state='active',binding_json=excluded.binding_json,
          subscription_id=NULL,assurance=excluded.assurance,updated_at=excluded.updated_at`)
        .run(owner,peerId,kind,displayName ?? null,(old?.generation ?? 0)+1,binding ? canonicalJSON(binding) : null,assurance,now,now);
      return { duplicate: false, peer: this.getPeer(owner,peerId) };
    });
  }
  bindSubscription(owner,id,generation,subscriptionId,now) {
    return this.transaction(() => {
      const p = this.getPeer(owner,id);
      if (!p || p.state !== 'active' || p.generation !== generation || p.kind === 'local') throw new Error('Peer generation is not active');
      if (p.subscriptionId && p.subscriptionId !== subscriptionId) throw new Error('Peer callback is already bound; unregister and register before replacing it');
      this.db.prepare('UPDATE peers SET subscription_id=?,updated_at=? WHERE owner=? AND peer_id=?').run(subscriptionId,now,owner,id);
      return this.getPeer(owner,id);
    });
  }
  unregister(owner,id,now) {
    return this.transaction(() => {
      const p = this.getPeer(owner,id); if (!p) return undefined;
      this.db.prepare("UPDATE peers SET state='stopped',updated_at=? WHERE owner=? AND peer_id=?").run(now,owner,id);
      this.db.prepare(`UPDATE peer_messages SET delivery_state='cancelled',reason='peer_unregistered'
        WHERE owner=? AND (from_peer_id=? OR to_peer_id=?) AND delivery_state IN ('accepted','queued')`).run(owner,id,id);
      return this.getPeer(owner,id);
    });
  }
  revokeOwner(owner,now) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO peer_owner_revocations(owner,revoked_at) VALUES (?,?)
        ON CONFLICT(owner) DO UPDATE SET revoked_at=MAX(revoked_at,excluded.revoked_at)`).run(owner,now);
      this.db.prepare("UPDATE peers SET state='stopped',updated_at=? WHERE owner=?").run(now,owner);
      this.db.prepare("UPDATE peer_messages SET delivery_state='cancelled',reason='access_revoked' WHERE owner=? AND delivery_state IN ('accepted','queued')").run(owner);
    });
  }
  nativeRequestAuthorized(owner,submittedAt) {
    const revoked = this.db.prepare('SELECT revoked_at FROM peer_owner_revocations WHERE owner=?').get(owner);
    if (!revoked) return true;
    return typeof submittedAt === 'string' && Date.parse(submittedAt) > revoked.revoked_at;
  }
  getMessage(owner,id) { return message(this.db.prepare('SELECT * FROM peer_messages WHERE owner=? AND message_id=?').get(owner,id)); }
  getMessageByEvent(owner,eventId) { return message(this.db.prepare('SELECT * FROM peer_messages WHERE owner=? AND event_id=?').get(owner,eventId)); }
  putMessage(owner,input,now,assurance) {
    const body = canonicalJSON({ fromPeerId: input.fromPeerId, toPeerId: input.toPeerId, text: input.text, inReplyTo: input.inReplyTo ?? null });
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM peer_messages WHERE owner=? AND message_id=?').get(owner,input.messageId);
      if (old) { if (old.body !== body) throw new Error('Message ID already belongs to different content or participants'); return { duplicate: true, message: message(old) }; }
      const from = this.getPeer(owner,input.fromPeerId), to = this.getPeer(owner,input.toPeerId);
      if (!from || !to || from.state !== 'active' || to.state !== 'active') throw new Error('Both peers must be registered and active');
      let rootId = input.messageId, hop = 0;
      if (input.inReplyTo) {
        const original = this.getMessage(owner,input.inReplyTo);
        if (!original || original.toPeerId !== from.peerId || original.fromPeerId !== to.peerId ||
          original.generation !== from.generation || original.fromGeneration !== to.generation) throw new Error('Reply must reverse the original peers and generations');
        if (this.db.prepare('SELECT 1 FROM peer_messages WHERE owner=? AND in_reply_to=?').get(owner,input.inReplyTo)) throw new Error('This message already has a reply');
        rootId = original.rootId; hop = original.hop+1;
        if (hop > 8) throw new Error('Reply hop limit reached');
      }
      const insert = this.db.prepare(`INSERT INTO peer_messages(owner,message_id,body,from_peer_id,to_peer_id,from_generation,to_generation,
        text,in_reply_to,root_id,hop,event_id,created_at,assurance,delivery_state,request_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      // Public message UUIDs are scoped to an owner; dispatch receipts are global
      // within a host. Persist one globally unique internal ID for both routes.
      for (let attempt = 0; ; attempt++) {
        const internalId = 'peer.'+randomUUID();
        try {
          insert.run(owner,input.messageId,body,from.peerId,to.peerId,from.generation,to.generation,
            input.text,input.inReplyTo ?? null,rootId,hop,internalId,now,assurance,
            to.kind === 'local' ? 'queued' : 'accepted',to.kind === 'local' ? internalId : null);
          break;
        } catch (error) {
          if (attempt >= 7 || error.message !== 'UNIQUE constraint failed: peer_messages.event_id') throw error;
        }
      }
      return { duplicate: false, message: this.getMessage(owner,input.messageId) };
    });
  }
  listMessages(owner,peerId,limit = 50,{ includeProcessed = false,generation } = {}) {
    return this.db.prepare(`SELECT * FROM peer_messages WHERE owner=? AND to_peer_id=?
      AND (? OR processed_at IS NULL) AND (? IS NULL OR to_generation=?)
      ORDER BY created_at DESC,rowid DESC LIMIT ?`)
      .all(owner,peerId,includeProcessed ? 1 : 0,generation ?? null,generation ?? null,limit).map(message);
  }
  messagesForGeneration(owner,peerId,generation) {
    return this.db.prepare('SELECT * FROM peer_messages WHERE owner=? AND to_peer_id=? AND to_generation=? ORDER BY created_at,rowid').all(owner,peerId,generation).map(message);
  }
  pendingMessages({ afterRowId = 0,limit = 1024 } = {}) {
    if (!Number.isSafeInteger(afterRowId) || afterRowId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error('Invalid pending-message scan');
    return this.db.prepare(`SELECT m.*,m.rowid AS scan_row_id FROM peer_messages m
      JOIN peers sender ON sender.owner=m.owner AND sender.peer_id=m.from_peer_id
        AND sender.state='active' AND sender.generation=m.from_generation
      JOIN peers recipient ON recipient.owner=m.owner AND recipient.peer_id=m.to_peer_id
        AND recipient.state='active' AND recipient.generation=m.to_generation
      WHERE m.rowid>? AND m.processed_at IS NULL AND ((m.event_recorded=0 AND m.delivery_state='accepted')
        OR m.delivery_state IN ('queued','submitting','delivery_unknown','wake_submitted'))
      ORDER BY m.rowid LIMIT ?`).all(afterRowId,limit).map(row => ({ ...message(row),scanRowId: row.scan_row_id }));
  }
  markEvent(owner,id) { this.db.prepare('UPDATE peer_messages SET event_recorded=1 WHERE owner=? AND message_id=?').run(owner,id); this.secureFiles(); }
  setDelivery(owner,id,state,{ reason = null,turnId = null } = {}) {
    // An in-flight result may arrive after unregister/ACK. Never resurrect cancelled work.
    this.db.prepare(`UPDATE peer_messages SET delivery_state=?,reason=?,turn_id=COALESCE(?,turn_id)
      WHERE owner=? AND message_id=? AND delivery_state!='cancelled'`).run(state,reason,turnId,owner,id); this.secureFiles();
    return this.getMessage(owner,id);
  }
  ack(owner,id,peerId,now) {
    return this.transaction(() => {
      const m = this.getMessage(owner,id);
      if (!m || m.toPeerId !== peerId) throw new Error('Only the recipient may acknowledge this message');
      const p = this.getPeer(owner,peerId);
      if (!p || p.state !== 'active' || p.generation !== m.generation) throw new Error('Recipient generation is not active');
      this.db.prepare('UPDATE peer_messages SET processed_at=COALESCE(processed_at,?) WHERE owner=? AND message_id=?').run(now,owner,id);
      return this.getMessage(owner,id);
    });
  }
  ownerRevoked(owner) {
    return Boolean(this.db.prepare('SELECT 1 FROM peer_owner_revocations WHERE owner=?').get(owner));
  }
  webhookBinding({ owner,peerId,generation }) {
    return this.db.prepare('SELECT * FROM peer_webhook_bindings WHERE owner=? AND peer_id=? AND generation=?').get(owner,peerId,generation);
  }
  disableWebhook(target,reason) {
    this.db.prepare('UPDATE peer_webhook_bindings SET disabled_reason=COALESCE(disabled_reason,?) WHERE owner=? AND peer_id=? AND generation=?')
      .run(reason,target.owner,target.peerId,target.generation); this.secureFiles();
  }
  bindWebhook({ owner,peerId,generation,routineId,urlHash },now) {
    return this.transaction(() => {
      const p = this.getPeer(owner,peerId);
      if (this.ownerRevoked(owner) || !p || p.state !== 'active' || p.kind === 'local' || p.generation !== generation) throw new Error('Webhook wake target is not an active authorized peer generation');
      const old = this.db.prepare('SELECT * FROM peer_webhook_bindings WHERE owner=? AND peer_id=? AND generation=?').get(owner,peerId,generation);
      if (old) {
        if (old.routine_id !== routineId || old.url_hash !== urlHash) throw new Error('Webhook wake identity cannot be rebound to another routine or URL');
        return old;
      }
      const watermark = this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM peer_messages').get().value;
      this.db.prepare('INSERT INTO peer_webhook_bindings(owner,peer_id,generation,routine_id,url_hash,watermark,created_at) VALUES (?,?,?,?,?,?,?)').run(owner,peerId,generation,routineId,urlHash,watermark,now);
      return this.db.prepare('SELECT * FROM peer_webhook_bindings WHERE owner=? AND peer_id=? AND generation=?').get(owner,peerId,generation);
    });
  }
  webhookCandidates({ owner,peerId,generation },limit = 1024,messageId = null) {
    return this.db.prepare(`SELECT m.* FROM peer_messages m
      JOIN peer_webhook_bindings b ON b.owner=m.owner AND b.peer_id=m.to_peer_id AND b.generation=m.to_generation
      JOIN peers sender ON sender.owner=m.owner AND sender.peer_id=m.from_peer_id AND sender.state='active' AND sender.generation=m.from_generation
      JOIN peers recipient ON recipient.owner=m.owner AND recipient.peer_id=m.to_peer_id AND recipient.state='active' AND recipient.kind!='local' AND recipient.generation=m.to_generation
      WHERE m.owner=? AND m.to_peer_id=? AND m.to_generation=? AND m.rowid>b.watermark AND (? IS NULL OR m.message_id=?)
        AND b.disabled_reason IS NULL AND m.processed_at IS NULL AND m.delivery_state!='cancelled'
        AND NOT EXISTS(SELECT 1 FROM peer_owner_revocations r WHERE r.owner=m.owner)
        AND NOT EXISTS(SELECT 1 FROM peer_webhook_claims c WHERE c.owner=m.owner AND c.message_id=m.message_id)
      ORDER BY m.rowid LIMIT ?`).all(owner,peerId,generation,messageId,messageId,limit).map(message);
  }
  claimWebhook(target,id,now) {
    return this.transaction(() => {
      // Recheck all eligibility in the same transaction as the unique claim.
      const m = this.webhookCandidates(target,1,id)[0];
      if (!m) return undefined;
      this.db.prepare("INSERT INTO peer_webhook_claims(owner,message_id,state,claimed_at) VALUES (?,?,'claimed',?)").run(m.owner,id,now);
      return m;
    });
  }
  recoverWebhookClaims(now) {
    this.db.prepare("UPDATE peer_webhook_claims SET state='unknown',reason='restart_inflight',completed_at=? WHERE state='claimed'").run(now); this.secureFiles();
  }
  finishWebhook(owner,id,{ state,status = null,reason = null },now) {
    this.db.prepare("UPDATE peer_webhook_claims SET state=?,status=?,reason=?,completed_at=? WHERE owner=? AND message_id=? AND state='claimed'").run(state,status,reason,now,owner,id); this.secureFiles();
  }
  webhookReceipt(owner,id) {
    const r = this.db.prepare('SELECT state,claimed_at,completed_at,status,reason FROM peer_webhook_claims WHERE owner=? AND message_id=?').get(owner,id);
    return r && { state: r.state,claimedAt: r.claimed_at,completedAt: r.completed_at,status: r.status,reason: r.reason };
  }
  close() { this.db.close(); }
}
