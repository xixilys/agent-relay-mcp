import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { PEER_ID_PATTERN } from './peer-store.js';
import { SafeCallbackClient, CallbackEndpointError, callbackURL } from './event-delivery.js';

const safeReasons = new Set(['invalid_url','unsafe_destination','payload_too_large','redirect','response_too_large',
  'subscription_cancelled','timeout','dns_error','transport_error']);

async function credentials(filename) {
  let file;
  try {
    file = await open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 16384) throw new Error();
    const value = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['url','token'].includes(k)) ||
      typeof value.token !== 'string' || !value.token || value.token.length > 8192 || /[^\x21-\x7e]/.test(value.token)) throw new Error();
    return { url: callbackURL(value.url).href,token: value.token };
  } catch { throw new Error('Webhook wake credential file is invalid or inaccessible'); }
  finally { await file?.close(); }
}

/** A separate notification receipt: one durable attempt per message, never retry.
 * A lost response cannot prove whether the remote routine started. */
export class PeerWebhookWake {
  constructor({ store,targets = [],callbackClient = new SafeCallbackClient(),hasMcpCallback,now = Date.now }) {
    if (!Array.isArray(targets) || targets.length > 1) throw new Error('peerWakeTargets must contain at most one target');
    this.targets = targets.map(t => {
      if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(k => !['owner','peerId','generation','routineId','credentialFile'].includes(k)) ||
        typeof t.owner !== 'string' || !t.owner || typeof t.peerId !== 'string' || !PEER_ID_PATTERN.test(t.peerId) ||
        !Number.isSafeInteger(t.generation) || t.generation < 1 || typeof t.routineId !== 'string' || !PEER_ID_PATTERN.test(t.routineId) ||
        typeof t.credentialFile !== 'string' || !isAbsolute(t.credentialFile)) throw new Error('Invalid webhook wake target');
      return { ...t };
    });
    Object.assign(this,{ store,callbackClient,hasMcpCallback,now });
    this.active = new Map(); this.closed = false; this.initialized = false; this.flushPromise = null;
  }
  matches(owner,peerId,generation) {
    return this.targets.some(t => t.owner === owner && t.peerId === peerId && t.generation === generation);
  }
  eligible(t) {
    const p = this.store.getPeer(t.owner,t.peerId);
    return !this.closed && !t.disabledReason && !this.store.ownerRevoked(t.owner) && p?.state === 'active' && p.kind !== 'local' &&
      p.generation === t.generation && !this.hasMcpCallback(t);
  }
  inactiveReason(t) {
    const p = this.store.getPeer(t.owner,t.peerId);
    return this.store.ownerRevoked(t.owner) ? 'owner_revoked' : !p ? 'peer_missing' :
      p.generation !== t.generation ? 'generation_changed' : p.state !== 'active' ? 'peer_stopped' : null;
  }
  disableStoppedBinding(t,binding) {
    if (!binding) return false;
    const reason = binding.disabled_reason ?? this.inactiveReason(t);
    if (!reason) return false;
    this.store.disableWebhook(t,reason); t.disabledReason = reason;
    return true;
  }
  async ready() {
    if (this.initialized) return;
    for (const t of this.targets) {
      const binding = this.store.webhookBinding(t);
      if (binding && binding.routine_id !== t.routineId) throw new Error('Webhook wake identity cannot be rebound to another routine or URL');
      if (this.disableStoppedBinding(t,binding)) continue;
      if (!this.eligible(t)) throw new Error('Webhook wake target must be active, authorized, and have no active MCP callback');
      const c = await credentials(t.credentialFile);
      if (this.disableStoppedBinding(t,binding)) continue;
      if (!this.eligible(t)) throw new Error('Webhook wake target changed during initialization');
      this.store.bindWebhook({ ...t,urlHash: createHash('sha256').update(c.url).digest('hex') },this.now());
      t.credentials = c;
    }
    this.store.recoverWebhookClaims(this.now());
    this.initialized = true;
  }
  hasPending() {
    return this.initialized && this.targets.some(t => this.eligible(t) && this.store.webhookCandidates(t,1).length);
  }
  flush() {
    if (!this.initialized || this.closed) return Promise.resolve();
    if (this.flushPromise) return this.flushPromise;
    const action = this.flushBatch(); this.flushPromise = action;
    action.finally(() => { if (this.flushPromise === action) this.flushPromise = null; }).catch(() => {});
    return action;
  }
  async flushBatch() {
    for (const t of this.targets) {
      if (!this.eligible(t)) continue;
      for (const candidate of this.store.webhookCandidates(t)) {
        if (!this.eligible(t)) break;
        const m = this.store.claimWebhook(t,candidate.messageId,this.now());
        if (!m) continue;
        const controller = new AbortController();
        this.active.set(m.eventId,{ controller,message: m });
        let result;
        try {
          const response = await this.callbackClient.post(t.credentials.url,{
            headers: { 'Content-Type': 'application/json',Authorization: `Bearer ${t.credentials.token}` },
            body: JSON.stringify({ eventId: m.eventId,messageId: m.messageId,peerId: m.toPeerId,generation: m.generation }),
            maxResponseBytes: 16384,signal: controller.signal,
          });
          if (!Number.isInteger(response.status)) throw new Error();
          result = { state: response.status === 200 ? 'webhook_accepted' : 'failed',status: response.status,
            reason: response.status === 200 ? null : 'http_error' };
        } catch (error) {
          // Never retain errors, URLs, response bodies or credentials. No exception permits retry.
          const reason = error instanceof CallbackEndpointError && safeReasons.has(error.data?.reason) ? error.data.reason : 'transport_error';
          result = { state: 'unknown',reason };
        } finally { this.active.delete(m.eventId); }
        this.store.finishWebhook(m.owner,m.messageId,result,this.now());
      }
    }
  }
  cancelInvalid() {
    for (const { controller,message: m } of this.active.values()) {
      const from = this.store.getPeer(m.owner,m.fromPeerId),to = this.store.getPeer(m.owner,m.toPeerId);
      if (this.store.ownerRevoked(m.owner) || from?.state !== 'active' || to?.state !== 'active' ||
        from.generation !== m.fromGeneration || to.generation !== m.generation) controller.abort();
    }
  }
  async close() {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    if (this.flushPromise) await this.flushPromise.catch(() => {});
  }
}
