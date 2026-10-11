import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { PeerService,PEER_EVENT } from '../src/peer-service.js';

const secret = 'whsec_' + randomBytes(32).toString('base64');
const binding = { hostId: 'mac',agentId: 'agent1',workspaceId: 'workspace1',cwd: '/fixture',serverId: 'server1',requestId: 'existing1',command: 'node /fixture/peer-message.mjs' };
const native = { owner: 'owner',hostId: 'mac',agentId: 'agent1',peerId: 'local',generation: 1 };
const send = extra => ({ messageId: randomUUID(),fromPeerId: 'sender',toPeerId: 'receiver',text: 'fixture',...extra });
async function fixture(t,options = {}) {
  const dir = await mkdtemp(join(tmpdir(),'peer-service-')); const posts = [];
  const service = new PeerService({ stateDir: dir,now: () => 1000,
    resolveNative: async () => binding,
    callbackClient: { async post(url,req) {
      const data = JSON.parse(req.body);
      if (data.type === 'verification') return { status: 200,body: JSON.stringify({ challenge: data.challenge }) };
      posts.push({ url,data }); return { status: 202,body: '{}' };
    } },...options });
  t.after(async () => { await service.close(); await rm(dir,{ recursive: true,force: true }); });
  const call = (name,args,actor,owner = 'owner') => service.call(name,args,{ owner,actor });
  for (const peerId of ['sender','receiver']) await call('register_peer',{ peerId,kind: 'chat' });
  return { service,call,posts,dir };
}
const subscription = (peerId = 'receiver',generation = 1,url = 'https://callback.example/receiver') => ({ name: PEER_EVENT,
  arguments: { peerId,generation },delivery: { mode: 'webhook',url,secret },ttlMs: 60_000 });

test('pending mailbox first bind emits fixed original event; read/ACK never emit and callback receipt differs from processing',async t => {
  const { service,call,posts } = await fixture(t);
  const args = send(); const accepted = await call('send_peer_message',args);
  assert.equal(accepted.status,'accepted'); assert.equal(accepted.senderIdentityAssurance,'claimed'); assert.equal(accepted.processed,false);
  assert.equal(service.eventStore.listDeliveries().length,0);
  await service.subscribe('owner',subscription()); await service.delivery.flushDue();
  assert.equal(posts.length,1); assert.equal(posts[0].data.eventId,accepted.eventId);
  assert.equal(posts[0].data.timestamp,new Date(accepted.createdAt).toISOString());
  assert.equal(posts[0].data.data.messageId,args.messageId);
  const received = await call('get_peer_message',{ messageId: args.messageId });
  assert.equal(received.deliveryState,'callback_received'); assert.equal(received.processingState,'unacknowledged');
  const ack = await call('ack_peer_message',{ messageId: args.messageId,peerId: 'receiver' });
  assert.equal(ack.processingState,'processed');
  const duplicate = await call('send_peer_message',args); assert.equal(duplicate.duplicate,true);
  await service.subscribe('owner',subscription()); await service.delivery.flushDue();
  assert.equal(posts.length,1); assert.equal(service.eventStore.listDeliveries().length,1);
  const listed = await call('list_peers',{});
  assert.ok(!JSON.stringify(listed).includes('callback.example')); assert.ok(!JSON.stringify(listed).includes(secret));
  assert.ok(!JSON.stringify(received).includes(secret));
});

test('owner isolation, schema validation, trusted native actor restrictions and self-registration',async t => {
  const { service,call } = await fixture(t);
  const local = await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' },{ ...native,peerId: undefined });
  assert.equal(local.senderIdentityAssurance,'native_capability'); assert.equal(local.command,binding.command);
  assert.equal(service.nativePeer('owner','mac','agent1').peerId,'local');
  assert.equal(service.nativePeer('owner','wsl','agent1'),undefined);
  await assert.rejects(call('register_peer',{ peerId: 'fake',kind: 'local',hostId: 'wsl',agentId: 'agent1' },{ ...native,peerId: undefined }),/authenticated/);
  await assert.rejects(call('register_peer',{ peerId: 'second',kind: 'local',hostId: 'mac',agentId: 'agent1' }),/another peer/);
  await assert.rejects(call('send_peer_message',send(),native),/own peer/);
  await assert.rejects(call('send_peer_message',send({ fromPeerId: 'local' }),{ ...native,hostId: 'wsl' }),/binding/);
  await assert.rejects(call('send_peer_message',send({ fromPeerId: 'local' }),{ ...native,generation: 2 }),/binding/);
  await assert.rejects(call('register_peer',{ peerId: 'bad id',kind: 'chat' }),/invalid/);
  await assert.rejects(call('register_peer',{ peerId: 'chat2',kind: 'chat',url: 'https://evil.example' }),/invalid/);
  const r = await call('send_peer_message',send());
  await assert.rejects(call('get_peer_message',{ messageId: r.messageId },native),/another peer/);
  await assert.rejects(call('get_peer_message',{ messageId: r.messageId },undefined,'other'),/not found/);
  await assert.rejects(call('ack_peer_message',{ messageId: r.messageId,peerId: 'receiver' },undefined,'other'),/not found/);
  await assert.rejects(call('list_peer_messages',{ peerId: 'receiver' },native),/own peer/);
  const own = await call('send_peer_message',send({ fromPeerId: 'local' }),native);
  assert.equal(own.senderIdentityAssurance,'native_capability');
  const oauthClaim = await call('send_peer_message',send({ fromPeerId: 'local' }));
  assert.equal(oauthClaim.senderIdentityAssurance,'claimed');
  assert.equal((await call('get_peer_message',{ messageId: own.messageId },native)).text,'fixture');
  await assert.rejects(call('list_peers',{},native,'other'),/owner mismatch/);
});

test('message intent to event recovery and owner-scoped event IDs across identical message UUIDs',async t => {
  const { service,call } = await fixture(t);
  const args = send();
  const initial = service.store.putMessage('owner',args,500,'claimed').message;
  assert.equal(initial.eventRecorded,false);
  await service.ready(); assert.equal(service.store.getMessage('owner',args.messageId).eventRecorded,true);
  await service.subscribe('owner',subscription());
  const first = service.eventStore.listDeliveries({ eventId: initial.eventId }); assert.equal(first.length,1);
  for (const peerId of ['sender','receiver']) await call('register_peer',{ peerId,kind: 'chat' },undefined,'other');
  const other = await call('send_peer_message',{ ...args,text: 'other owner content' },undefined,'other');
  assert.notEqual(other.eventId,initial.eventId);
  assert.equal((await call('send_peer_message',args)).createdAt,500);
  await assert.rejects(call('send_peer_message',{ ...args,text: 'conflict' }),/different content/);
});

test('same-generation callback cannot be replaced; expiration refresh never replays expired event; new generation excludes old messages',async t => {
  let now = 1000;
  const { service,call,posts } = await fixture(t,{ now: () => now });
  await service.subscribe('owner',subscription());
  const args = send(); const first = await call('send_peer_message',args);
  now = 70_000; await service.delivery.flushDue(); assert.equal(posts.length,0);
  assert.equal(service.eventStore.listDeliveries({ eventId: first.eventId })[0].state,'expired');
  await service.subscribe('owner',subscription()); await service.delivery.flushDue(); assert.equal(posts.length,0);
  await assert.rejects(service.subscribe('owner',subscription('receiver',1,'https://callback.example/new')),/already bound/);
  service.unsubscribe('owner',subscription());
  await assert.rejects(service.subscribe('owner',subscription('receiver',1,'https://callback.example/new')),/already bound/);
  await call('unregister_peer',{ peerId: 'receiver' });
  const p = await call('register_peer',{ peerId: 'receiver',kind: 'chat' }); assert.equal(p.generation,2);
  await service.subscribe('owner',subscription('receiver',2)); await service.delivery.flushDue(); assert.equal(posts.length,0);
  await assert.rejects(service.subscribe('owner',subscription('receiver',1)),/not authorized/);
  await assert.rejects(call('ack_peer_message',{ messageId: args.messageId,peerId: 'receiver' }),/generation/);
});

test('callback verification cancellation and in-flight delivery cancellation cannot resurrect revoked work',async t => {
  let releaseVerify,releaseDelivery;
  const verifyWait = new Promise(resolve => { releaseVerify = resolve; });
  const deliveryWait = new Promise(resolve => { releaseDelivery = resolve; });
  let verifying = false,delivering = false;
  const { service,call } = await fixture(t,{ callbackClient: { async post(_url,req) {
    const data = JSON.parse(req.body);
    if (data.type === 'verification') { verifying = true; await verifyWait; return { status: 200,body: JSON.stringify({ challenge: data.challenge }) }; }
    delivering = true; await deliveryWait; return { status: 202,body: '{}' };
  } } });
  const pendingSub = service.subscribe('owner',subscription());
  while (!verifying) await new Promise(resolve => setImmediate(resolve));
  service.revokeOwner('owner'); releaseVerify();
  await assert.rejects(pendingSub,/cancelled|authorized/);
  assert.equal(service.eventStore.activeSubscriptions({ owner: 'owner',now: 1000 }).length,0);
  for (const peerId of ['sender','receiver']) await call('register_peer',{ peerId,kind: 'chat' });
  await service.subscribe('owner',subscription('receiver',2));
  const msg = await call('send_peer_message',send()); const flushing = service.delivery.flushDue();
  while (!delivering) await new Promise(resolve => setImmediate(resolve));
  await call('unregister_peer',{ peerId: 'sender' }); releaseDelivery(); await flushing;
  assert.equal(service.eventStore.listDeliveries({ eventId: msg.eventId })[0].state,'cancelled');
});

test('busy native queue, stable request id, unknown never dispatches again, inspect observed marker, ACK never wakes',async t => {
  let busy = true,calls = 0,observed;
  const ids = [];
  const { service,call } = await fixture(t,{ dispatchNative: async ({ message }) => {
    calls++; ids.push(message.requestId);
    return { state: busy ? 'queued' : 'delivery_unknown',requestId: message.requestId,reason: busy ? 'busy' : 'unknown' };
  },inspectNative: async () => observed });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' },{ ...native,peerId: undefined });
  const args = send({ toPeerId: 'local' });
  assert.equal((await call('send_peer_message',args)).deliveryState,'queued');
  await service.flushPending(); assert.equal(calls,1);
  busy = false; await service.flushPending(); assert.equal(calls,2);
  const stored = service.store.getMessage('owner',args.messageId);
  assert.deepEqual(ids,[stored.requestId,stored.requestId]);
  assert.equal(stored.requestId,stored.eventId);
  assert.notEqual(stored.requestId,'peer.'+args.messageId);
  for (let i = 0; i < 3; i++) await service.flushPending();
  await call('send_peer_message',args); assert.equal(calls,2);
  assert.equal((await call('get_peer_message',{ messageId: args.messageId })).deliveryState,'delivery_unknown');
  observed = { state: 'wake_observed',turnId: 'matched-turn' }; await service.flushPending();
  const receipt = await call('get_peer_message',{ messageId: args.messageId }); assert.equal(receipt.deliveryState,'wake_observed'); assert.equal(receipt.turnId,'matched-turn');
  await call('ack_peer_message',{ messageId: args.messageId,peerId: 'local' },native);
  await service.flushPending(); assert.equal(calls,2); assert.equal(service.eventStore.listDeliveries().length,0);
});

test('native submitting recovery reuses original ID; unregister stops busy work and old generation cannot dispatch',async t => {
  const ids = [];
  const { service,call } = await fixture(t,{ dispatchNative: async ({ message }) => { ids.push(message.requestId); return { state: 'queued',requestId: message.requestId }; } });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  const args = send({ toPeerId: 'local' }); const m = service.store.putMessage('owner',args,1000,'claimed').message;
  service.store.setDelivery('owner',m.messageId,'submitting'); await service.ready();
  assert.deepEqual(ids,[m.requestId]);
  assert.equal(m.requestId,m.eventId);
  await call('unregister_peer',{ peerId: 'local' });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' }); await service.flushPending();
  assert.equal(ids.length,1); assert.equal(service.store.getMessage('owner',m.messageId).deliveryState,'cancelled');
});

test('concurrent replies and ACK remain one reply and one processing timestamp without callback side effects',async t => {
  const { service,call,posts } = await fixture(t);
  const first = await call('send_peer_message',send());
  const reply = send({ fromPeerId: 'receiver',toPeerId: 'sender',inReplyTo: first.messageId });
  const results = await Promise.allSettled([call('send_peer_message',reply),call('send_peer_message',{ ...reply,messageId: randomUUID() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
  const acks = await Promise.all([call('ack_peer_message',{ messageId: first.messageId,peerId: 'receiver' }),call('ack_peer_message',{ messageId: first.messageId,peerId: 'receiver' })]);
  assert.equal(acks[0].processedAt,acks[1].processedAt); assert.equal(posts.length,0);
  assert.equal((await call('send_peer_message',reply)).duplicate,true);
});

test('subscription/message double-write crash recovery preserves original callback and exact event body',async t => {
  const { service,call,posts } = await fixture(t);
  const params = subscription();
  // Simulate EventDelivery commit before PeerStore binding.
  const sub = await service.delivery.subscribe(params.name,params.arguments,params.delivery,params.ttlMs,null,'owner');
  assert.equal(service.store.getPeer('owner','receiver').subscriptionId,null);
  await assert.rejects(service.subscribe('owner',subscription('receiver',1,'https://callback.example/other')),/already bound/);
  const prebind = await call('send_peer_message',send({ text: 'created before subscription' }));
  // Drop only this outbox row to model a crash after subscription commit before backlog enqueue.
  service.eventStore.db.prepare('DELETE FROM event_outbox WHERE event_id=?').run(prebind.eventId);
  const args = send(); const m = service.store.putMessage('owner',args,123,'claimed').message;
  service.emit(m);
  service.store.db.prepare('UPDATE peer_messages SET event_recorded=0 WHERE owner=? AND message_id=?').run('owner',m.messageId);
  await service.ready();
  assert.equal(service.store.getPeer('owner','receiver').subscriptionId,sub.id);
  assert.equal(service.eventStore.listDeliveries({ eventId: m.eventId }).length,1);
  assert.equal(service.eventStore.listDeliveries({ eventId: prebind.eventId }).length,1);
  await service.delivery.flushDue(); assert.equal(posts.length,2);
  assert.equal(posts.find(p => p.data.eventId === m.eventId).data.timestamp,new Date(123).toISOString());
  assert.equal((await call('get_peer_message',{ messageId: m.messageId })).deliveryState,'callback_received');
});

test('re-registered native actor cannot read old-generation private messages; registration cancellation wins native resolve race',async t => {
  let release,wait = false,entered = false;
  const pending = new Promise(resolve => { release = resolve; });
  const { service,call } = await fixture(t,{ resolveNative: async () => {
    if (wait) { entered = true; await pending; } return binding;
  } });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  const m = await call('send_peer_message',send({ toPeerId: 'local' }));
  await call('unregister_peer',{ peerId: 'local' });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  const current = { ...native,generation: 2 };
  await assert.rejects(call('get_peer_message',{ messageId: m.messageId },current),/another peer/);
  assert.equal((await call('list_peer_messages',{ peerId: 'local' },current)).messages.length,0);
  assert.equal((await call('get_peer_message',{ messageId: m.messageId })).text,'fixture');
  await call('unregister_peer',{ peerId: 'local' }); wait = true;
  const registering = call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  service.revokeOwner('owner'); release(); await assert.rejects(registering,/cancelled/);
  assert.equal(service.nativePeer('owner','mac','agent1'),undefined);
});

test('persistent restart reconciles native unknown without a second dispatch and retains fixed original receipt',async t => {
  const dir = await mkdtemp(join(tmpdir(),'peer-restart-')); let service,calls = 0;
  const options = { stateDir: dir,now: () => 1000,resolveNative: async () => binding,
    dispatchNative: async ({ message }) => { calls++; return { state: 'delivery_unknown',requestId: message.requestId }; },
    inspectNative: async () => undefined };
  t.after(async () => { await service?.close(); await rm(dir,{ recursive: true,force: true }); });
  service = new PeerService(options);
  await service.call('register_peer',{ peerId: 'sender',kind: 'chat' },{ owner: 'owner' });
  await service.call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' },{ owner: 'owner' });
  const args = send({ toPeerId: 'local' });
  const original = await service.call('send_peer_message',args,{ owner: 'owner' }); assert.equal(calls,1);
  await service.close(); service = new PeerService(options); await service.ready();
  const recovered = await service.call('send_peer_message',args,{ owner: 'owner' });
  assert.equal(calls,1); assert.equal(recovered.duplicate,true);
  for (const k of ['messageId','eventId','createdAt','requestId','generation','fromGeneration']) assert.equal(recovered[k],original[k]);
  assert.equal(original.status,'accepted'); assert.equal(recovered.deliveryState,'delivery_unknown');
});

test('same public message UUID across owners has distinct native dispatch IDs and persists unchanged across reopen',async t => {
  const dir = await mkdtemp(join(tmpdir(),'peer-native-owner-')); let service;
  const submitted = new Set();
  const options = { stateDir: dir,now: () => 1000,resolveNative: async () => binding,
    dispatchNative: async ({ message }) => {
      assert.equal(submitted.has(message.requestId),false,'host-global DispatchStore would reject this ID collision');
      submitted.add(message.requestId); return { state: 'delivery_unknown',requestId: message.requestId };
    },inspectNative: async () => undefined };
  t.after(async () => { await service?.close(); await rm(dir,{ recursive: true,force: true }); });
  service = new PeerService(options);
  const args = send({ toPeerId: 'local' }); const originals = new Map();
  for (const owner of ['owner-a','owner-b']) {
    await service.call('register_peer',{ peerId: 'sender',kind: 'chat' },{ owner });
    await service.call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' },{ owner });
    originals.set(owner,await service.call('send_peer_message',args,{ owner }));
    await service.flushPending();
  }
  const a = originals.get('owner-a'),b = originals.get('owner-b');
  assert.equal(a.messageId,b.messageId); assert.notEqual(a.requestId,b.requestId); assert.notEqual(a.eventId,b.eventId);
  assert.equal(a.requestId,a.eventId); assert.equal(b.requestId,b.eventId); assert.equal(submitted.size,2);
  await service.close(); service = new PeerService(options); await service.ready();
  for (const [owner,original] of originals) {
    const recovered = await service.call('send_peer_message',args,{ owner });
    assert.equal(recovered.duplicate,true);
    assert.equal(recovered.messageId,args.messageId);
    assert.equal(recovered.eventId,original.eventId); assert.equal(recovered.requestId,original.requestId);
  }
  assert.equal(submitted.size,2);
});

test('unregister and owner revoke invalidate already-verified native actors while OAuth may retain history',async t => {
  for (const revoke of [false,true]) {
    const { service,call } = await fixture(t);
    await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
    const args = send({ fromPeerId: 'receiver',toPeerId: 'local' });
    const m = await call('send_peer_message',args);
    const alreadyVerifiedActor = { ...native };
    assert.equal((await call('get_peer_message',{ messageId: m.messageId },alreadyVerifiedActor)).text,'fixture');
    if (revoke) service.revokeOwner('owner'); else await call('unregister_peer',{ peerId: 'local' });
    await assert.rejects(call('get_peer_message',{ messageId: m.messageId },alreadyVerifiedActor),/binding mismatch/);
    await assert.rejects(call('list_peer_messages',{ peerId: 'local' },alreadyVerifiedActor),/binding mismatch/);
    await assert.rejects(call('ack_peer_message',{ messageId: m.messageId,peerId: 'local' },alreadyVerifiedActor),/binding mismatch/);
    const internal = service.store.getMessage('owner',m.messageId);
    assert.equal(service.actorCanRead('owner',alreadyVerifiedActor,internal),false);
    assert.equal((await call('get_peer_message',{ messageId: m.messageId })).text,'fixture');
  }
});

test('chat and dot default to manual mailboxes; inbox filters received/unprocessed before limit and read never acknowledges',async t => {
  const { service,call,posts } = await fixture(t);
  for (const kind of ['chat','dot']) {
    const p = await call('register_peer',{ peerId: kind+'-mailbox',kind });
    assert.equal(p.endpointState,'mailbox_only'); assert.equal(p.wakeMode,'manual');
  }
  assert.equal(service.eventStore.activeSubscriptions({ now: 1000 }).length,0);
  const unread = await call('send_peer_message',send());
  const processed = await call('send_peer_message',send({ text: 'newer processed item' }));
  await call('ack_peer_message',{ peerId: 'receiver',messageId: processed.messageId });
  const outgoing = await call('send_peer_message',send({ fromPeerId: 'receiver',toPeerId: 'sender',text: 'newest outgoing' }));
  const inbox = await call('list_peer_messages',{ peerId: 'receiver',limit: 1 });
  assert.deepEqual(inbox.messages.map(m => m.messageId),[unread.messageId]);
  assert.equal(inbox.messages[0].processed,false);
  assert.equal((await call('get_peer_message',{ messageId: unread.messageId })).processed,false);
  const history = await call('list_peer_messages',{ peerId: 'receiver',includeProcessed: true });
  assert.deepEqual(history.messages.map(m => m.messageId),[processed.messageId,unread.messageId]);
  assert.equal(history.messages.some(m => m.messageId === outgoing.messageId),false);
  assert.equal((await call('get_peer_message',{ messageId: outgoing.messageId })).text,'newest outgoing');
  assert.equal(posts.length,0);
  await service.subscribe('owner',subscription());
  const bound = (await call('list_peers',{ peerId: 'receiver' })).peers[0];
  assert.equal(bound.endpointState,'callback_bound'); assert.equal(bound.wakeMode,'event');
  const local = await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  assert.equal(local.wakeMode,'native_idle');
  await assert.rejects(call('list_peer_messages',{ peerId: 'receiver',includeProcessed: 'true' }),/invalid/);
});

test('slow native dispatch never delays durable acceptance, and close waits for the already-started flush',async t => {
  let release,entered = false,closingFinished = false;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { service,call } = await fixture(t,{ dispatchNative: async ({ message }) => {
    entered = true; await blocked; return { state: 'wake_submitted',requestId: message.requestId };
  } });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  const args = send({ toPeerId: 'local' });
  let timer;
  const timeout = new Promise((_,reject) => { timer = setTimeout(() => { release(); reject(new Error('Acceptance waited for native dispatch')); },1000); });
  let accepted;
  try { accepted = await Promise.race([call('send_peer_message',args),timeout]); }
  finally { clearTimeout(timer); }
  assert.equal(accepted.status,'accepted'); assert.equal(accepted.messageId,args.messageId);
  assert.equal(accepted.deliveryState,'queued'); assert.equal(accepted.processed,false);
  assert.equal(service.store.getMessage('owner',args.messageId).text,'fixture');
  assert.equal(entered,true);
  const duplicate = await call('send_peer_message',args); assert.equal(duplicate.duplicate,true);
  const closing = service.close().then(() => { closingFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closingFinished,false,'close must wait for the in-flight native operation');
  release(); await closing; assert.equal(closingFinished,true);
});

test('round-robin pending scan passes 1024 busy/unknown records to reach a later owner without resubmitting unknown wakes',async t => {
  const submitted = [],inspected = [];
  const { service,call } = await fixture(t,{ dispatchNative: async ({ message }) => {
    submitted.push(message.owner);
    return { state: message.owner === 'owner' ? 'queued' : 'wake_submitted',requestId: message.requestId };
  },inspectNative: async ({ message }) => { inspected.push(message.messageId); return undefined; } });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  let firstUnknown;
  for (let i = 0; i < 1024; i++) {
    const m = service.store.putMessage('owner',send({ toPeerId: 'local' }),1000+i,'claimed').message;
    if (i % 2 === 0) {
      service.store.setDelivery('owner',m.messageId,'delivery_unknown');
      firstUnknown ??= m;
    }
  }
  await call('register_peer',{ peerId: 'sender',kind: 'chat' },undefined,'later-owner');
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' },undefined,'later-owner');
  const later = service.store.putMessage('later-owner',send({ toPeerId: 'local' }),3000,'claimed').message;
  await service.flushPending();
  assert.equal(submitted.includes('later-owner'),false);
  assert.equal(submitted.length,512); assert.equal(inspected.length,512);
  assert.equal(service.scanRowId,1024);
  await service.flushPending();
  assert.equal(submitted.at(-1),'later-owner');
  assert.equal(service.store.getMessage('later-owner',later.messageId).deliveryState,'wake_submitted');
  assert.equal(service.store.getMessage('owner',firstUnknown.messageId).deliveryState,'delivery_unknown');
  assert.equal(service.scanRowId,0);
  // Unknown records retained after revoke/re-register must not hide later owners
  // from the scheduler's first-row check or from the scan itself.
  service.revokeOwner('owner');
  await call('register_peer',{ peerId: 'sender',kind: 'chat' });
  await call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'agent1' });
  assert.equal(service.store.pendingMessages({ limit: 1 })[0].owner,'later-owner');
  service.started = true; service.schedule(); assert.ok(service.timer);
  assert.equal((await call('get_peer_message',{ messageId: later.messageId },undefined,'later-owner')).scanRowId,undefined);
});
