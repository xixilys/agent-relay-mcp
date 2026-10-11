import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PeerStore } from '../src/peer-store.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'peer-store-')); const store = new PeerStore(dir);
  t.after(async () => { store.close(); await rm(dir,{ recursive: true,force: true }); });
  for (const owner of ['a','b']) for (const peerId of ['sender','receiver']) store.register(owner,{ peerId,kind: 'chat' },1000);
  return { store,dir };
}
const input = (extra = {}) => ({ messageId: randomUUID(),fromPeerId: 'sender',toPeerId: 'receiver',text: 'fixture',...extra });

test('private owner-scoped peer/messages: idempotent semantic body, conflict and no cross-owner event collision',async t => {
  const { store,dir } = await fixture(t); const m = input();
  const first = store.putMessage('a',m,1001,'claimed');
  assert.equal(first.duplicate,false); assert.equal(store.putMessage('a',m,2000,'claimed').duplicate,true);
  assert.equal(store.getMessage('a',m.messageId).createdAt,1001);
  assert.throws(() => store.putMessage('a',{ ...m,text: 'changed' },1002,'claimed'),/different content/);
  assert.throws(() => store.putMessage('a',{ ...m,toPeerId: 'sender' },1002,'claimed'),/different content/);
  assert.equal(store.getMessage('b',m.messageId),undefined);
  const other = store.putMessage('b',{ ...m,text: 'other owner' },1001,'claimed');
  assert.notEqual(other.message.eventId,first.message.eventId);
  assert.equal((await stat(join(dir,'peers.sqlite'))).mode & 0o777,0o600);
  assert.equal((await stat(dir)).mode & 0o777,0o700);
});

test('1024 retained messages do not block new mail or replies after reopen, and old receipts remain idempotent',async t => {
  const dir = await mkdtemp(join(tmpdir(),'peer-history-')); let store = new PeerStore(dir);
  t.after(async () => { store.close(); await rm(dir,{ recursive: true,force: true }); });
  for (const peerId of ['sender','receiver']) store.register('owner',{ peerId,kind: 'chat' },1000);
  let oldest;
  // Reproduce the live failure: 955 processed messages and 69 unprocessed.
  for (let i = 0; i < 1024; i++) {
    const args = input({ text: 'historical mail '+i }); oldest ??= args;
    store.putMessage('owner',args,1001+i,'claimed');
    if (i < 955) store.ack('owner',args.messageId,'receiver',3000+i);
  }
  const original = store.getMessage('owner',oldest.messageId);
  store.close(); store = new PeerStore(dir);
  const fresh = input({ text: 'new mail after retained history' });
  assert.equal(store.putMessage('owner',fresh,5000,'claimed').duplicate,false);
  assert.deepEqual(store.getMessage('owner',oldest.messageId),original);
  assert.equal(store.putMessage('owner',oldest,5001,'claimed').duplicate,true);
  assert.throws(() => store.putMessage('owner',{ ...oldest,text: 'changed' },5001,'claimed'),/different content/);
  const reply = input({ fromPeerId: 'receiver',toPeerId: 'sender',inReplyTo: oldest.messageId });
  assert.equal(store.putMessage('owner',reply,5002,'claimed').message.rootId,oldest.messageId);
  assert.equal(store.ack('owner',fresh.messageId,'receiver',5003).processedAt,5003);
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM peer_messages WHERE owner=?').get('owner').n),1026);
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM peer_messages WHERE owner=? AND processed_at IS NULL').get('owner').n),70);
  store.close(); store = new PeerStore(dir);
  assert.deepEqual(store.getMessage('owner',oldest.messageId),original);
  assert.equal(store.putMessage('owner',reply,6000,'claimed').duplicate,true);
});

test('registration ABA, immutable endpoint, retained history, and generation-safe replies/ACK',async t => {
  const { store } = await fixture(t); const m = store.putMessage('a',input(),1001,'claimed').message;
  assert.equal(store.register('a',{ peerId: 'receiver',kind: 'chat',displayName: 'new name' },1002).peer.generation,1);
  assert.throws(() => store.register('a',{ peerId: 'receiver',kind: 'dot' },1002),/unregister/);
  store.bindSubscription('a','receiver',1,'sub_one',1002);
  assert.throws(() => store.bindSubscription('a','receiver',1,'sub_two',1002),/already bound/);
  store.unregister('a','receiver',1003);
  assert.equal(store.getMessage('a',m.messageId).deliveryState,'cancelled');
  assert.equal(store.getMessage('a',m.messageId).text,'fixture');
  const peer = store.register('a',{ peerId: 'receiver',kind: 'chat' },1004).peer;
  assert.equal(peer.generation,2); assert.equal(peer.subscriptionId,null);
  assert.throws(() => store.ack('a',m.messageId,'receiver',1005),/generation/);
  assert.throws(() => store.putMessage('a',input({ fromPeerId: 'receiver',toPeerId: 'sender',inReplyTo: m.messageId }),1005,'claimed'),/generations/);
  assert.equal(store.putMessage('a',{ messageId: m.messageId,fromPeerId: m.fromPeerId,toPeerId: m.toPeerId,text: m.text },1006,'claimed').duplicate,true);
});

test('reply reservation atomic across two database handles; one reply, bounded hops; ACK idempotent',async t => {
  const { store,dir } = await fixture(t); const other = new PeerStore(dir); t.after(() => other.close());
  let m = store.putMessage('a',input(),1001,'claimed').message;
  const reply = input({ fromPeerId: 'receiver',toPeerId: 'sender',inReplyTo: m.messageId });
  const results = await Promise.allSettled([Promise.resolve().then(() => store.putMessage('a',reply,1002,'claimed')),
    Promise.resolve().then(() => other.putMessage('a',{ ...reply,messageId: randomUUID() },1002,'claimed'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
  const ack = store.ack('a',m.messageId,'receiver',1003); assert.equal(ack.processedAt,1003);
  assert.equal(other.ack('a',m.messageId,'receiver',1004).processedAt,1003);
  assert.throws(() => store.ack('a',m.messageId,'sender',1005),/recipient/);
  m = store.getMessage('a',reply.messageId);
  for (let i = 2; i <= 8; i++) m = store.putMessage('a',input({ fromPeerId: m.toPeerId,toPeerId: m.fromPeerId,inReplyTo: m.messageId }),1002+i,'claimed').message;
  assert.equal(m.hop,8);
  assert.throws(() => store.putMessage('a',input({ fromPeerId: m.toPeerId,toPeerId: m.fromPeerId,inReplyTo: m.messageId }),1011,'claimed'),/hop limit/);
});

test('revoke owner cancels queued work and preserves other owner',async t => {
  const { store } = await fixture(t); const a = store.putMessage('a',input(),1001,'claimed').message;
  const b = store.putMessage('b',input(),1001,'claimed').message;
  store.revokeOwner('a',1002);
  assert.equal(store.getMessage('a',a.messageId).deliveryState,'cancelled');
  assert.equal(store.getMessage('b',b.messageId).deliveryState,'accepted');
  assert.equal(store.listPeers('a').every(p => p.state === 'stopped'),true);
});

test('SQLite enforces globally unique internal event identity across owner records',async t => {
  const { store } = await fixture(t);
  const a = store.putMessage('a',input(),1001,'claimed').message;
  const b = store.putMessage('b',input(),1001,'claimed').message;
  assert.throws(() => store.db.prepare('UPDATE peer_messages SET event_id=? WHERE owner=? AND message_id=?').run(a.eventId,'b',b.messageId),/UNIQUE constraint failed: peer_messages.event_id/);
  assert.equal(store.getMessage('b',b.messageId).eventId,b.eventId);
});

test('owner revocation is durable even before peer registration and old native request times stay rejected after reopen',async t => {
  const dir = await mkdtemp(join(tmpdir(),'peer-revocation-')); let store = new PeerStore(dir);
  t.after(async () => { store.close(); await rm(dir,{ recursive: true,force: true }); });
  assert.equal(store.nativeRequestAuthorized('owner',undefined),true);
  store.revokeOwner('owner',1000); assert.equal(store.listPeers('owner').length,0);
  store.close(); store = new PeerStore(dir);
  for (const submittedAt of [undefined,'invalid',new Date(999).toISOString(),new Date(1000).toISOString()]) {
    assert.equal(store.nativeRequestAuthorized('owner',submittedAt),false);
  }
  assert.equal(store.nativeRequestAuthorized('owner',new Date(1001).toISOString()),true);
  assert.equal(store.nativeRequestAuthorized('other',new Date(999).toISOString()),true);
  store.register('owner',{ peerId: 'new-native',kind: 'local' },1001);
  assert.equal(store.nativeRequestAuthorized('owner',new Date(999).toISOString()),false);
  assert.equal(store.nativeRequestAuthorized('owner',new Date(1001).toISOString()),true);
  store.revokeOwner('owner',999); // A clock regression must not reopen old capabilities.
  assert.equal(store.nativeRequestAuthorized('owner',new Date(1000).toISOString()),false);
});
