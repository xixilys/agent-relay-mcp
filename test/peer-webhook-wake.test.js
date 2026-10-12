import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { PeerService,PEER_EVENT } from '../src/peer-service.js';
import { PeerStore } from '../src/peer-store.js';
import { PeerWebhookWake } from '../src/peer-webhook-wake.js';
import { CallbackEndpointError,SafeCallbackClient } from '../src/event-delivery.js';

const drain = async service => { await service.flushPending(); await service.webhookWake.flush(); };
const input = extra => ({ messageId: randomUUID(),fromPeerId: 'sender',toPeerId: 'receiver',text: 'private message text',...extra });
async function fixture(t,{ post,ready = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(),'peer-webhook-'));
  const credentialFile = join(dir,'wake.json');
  await writeFile(credentialFile,JSON.stringify({ url: 'https://wake.example/routine/mcp',token: 'test-secret' }),{ mode: 0o600 });
  const target = { owner: 'owner',peerId: 'receiver',generation: 1,routineId: 'mcp',credentialFile };
  const posts = [];
  const options = { stateDir: dir,peerWakeTargets: [target],callbackClient: { async post(url,request) {
    posts.push({ url,...request }); return post ? post(url,request) : { status: 200,body: 'discard me' };
  } } };
  let service = new PeerService(options);
  const call = (name,args,owner = 'owner') => service.call(name,args,{ owner });
  for (const peerId of ['sender','receiver']) await call('register_peer',{ peerId,kind: 'chat' });
  if (ready) await service.ready();
  const restart = async () => { await service.close(); service = new PeerService(options); await service.ready(); return service; };
  t.after(async () => { await service.close(); await rm(dir,{ recursive: true,force: true }); });
  return { get service() { return service; },call,posts,target,dir,credentialFile,restart,options };
}

test('fixed minimal payload, recorded MCP event without subscriber, UUID and concurrent scans never duplicate',async t => {
  const f = await fixture(t);
  const args = input();
  const m = f.service.store.putMessage('owner',args,1000,'claimed').message;
  f.service.emit(m);
  assert.equal(f.service.store.getMessage('owner',args.messageId).eventRecorded,true);
  assert.equal(f.service.eventStore.listDeliveries().length,0);
  await Promise.all([drain(f.service),drain(f.service),f.service.webhookWake.flush()]);
  assert.equal(f.posts.length,1);
  assert.equal(f.posts[0].url,'https://wake.example/routine/mcp');
  assert.equal(f.posts[0].headers.Authorization,'Bearer test-secret');
  assert.deepEqual(JSON.parse(f.posts[0].body),{ eventId: m.eventId,messageId: m.messageId,peerId: 'receiver',generation: 1 });
  assert.equal(f.posts[0].body.includes(args.text),false);
  await f.call('send_peer_message',args);
  await f.restart(); await drain(f.service);
  assert.equal(f.posts.length,1);
  const r = await f.call('get_peer_message',{ messageId: m.messageId });
  assert.equal(r.wakeNotification.state,'webhook_accepted'); assert.equal(r.deliveryState,'accepted');
  assert.equal(r.processingState,'unacknowledged'); assert.deepEqual(r.deliveries,[]);
  const peers = (await f.call('list_peers',{})).peers;
  const p = peers.find(p => p.peerId === 'receiver');
  assert.equal(p.endpointState,'mailbox_only'); assert.equal(p.wakeMode,'manual'); assert.equal(p.wakeNotificationMode,'webhook');
  assert.equal(JSON.stringify({ r,peers }).includes('test-secret'),false);
  assert.equal(JSON.stringify({ r,peers }).includes('wake.example'),false);
});

test('activation excludes old messages; rotation and restart preserve watermark and notification claims',async t => {
  const f = await fixture(t,{ ready: false });
  const old = f.service.store.putMessage('owner',input(),1000,'claimed').message;
  await f.service.ready();
  assert.equal(f.posts.length,0);
  const watermark = f.service.store.db.prepare('SELECT watermark,created_at FROM peer_webhook_bindings').get();
  await writeFile(f.credentialFile,JSON.stringify({ url: 'https://wake.example/routine/mcp',token: 'rotated-secret' }));
  await f.restart();
  assert.deepEqual(f.service.store.db.prepare('SELECT watermark,created_at FROM peer_webhook_bindings').get(),watermark);
  assert.equal(f.service.store.webhookReceipt('owner',old.messageId),undefined);
  const m = f.service.store.putMessage('owner',input(),2000,'claimed').message;
  await drain(f.service); assert.equal(f.posts.length,1);
  assert.equal(f.posts[0].headers.Authorization,'Bearer rotated-secret');
  assert.equal(f.service.store.webhookReceipt('owner',m.messageId).state,'webhook_accepted');
});

test('only HTTP 200 is accepted; exceptions and lost results stay unknown across restart without retry',async t => {
  for (const response of [200,201,202,204,400,429,500,'lost']) {
    const f = await fixture(t,{ post: async () => {
      if (response === 'lost') throw new Error('secret URL and body must never escape');
      return { status: response };
    } });
    const m = f.service.store.putMessage('owner',input(),1000,'claimed').message;
    await drain(f.service); await f.restart(); await drain(f.service);
    assert.equal(f.posts.length,1);
    const receipt = f.service.store.webhookReceipt('owner',m.messageId);
    assert.equal(receipt.state,response === 200 ? 'webhook_accepted' : response === 'lost' ? 'unknown' : 'failed');
    assert.equal(receipt.reason,response === 200 ? null : response === 'lost' ? 'transport_error' : 'http_error');
  }
});

test('durable pre-POST claim after crash becomes unknown and is never obtained again',async t => {
  const f = await fixture(t);
  const m = f.service.store.putMessage('owner',input(),1000,'claimed').message;
  assert.ok(f.service.store.claimWebhook(f.target,m.messageId,1000));
  assert.equal(f.service.store.claimWebhook(f.target,m.messageId,1000),undefined);
  await f.restart(); await drain(f.service);
  assert.equal(f.posts.length,0);
  assert.equal(f.service.store.webhookReceipt('owner',m.messageId).reason,'restart_inflight');
});

test('ACK, different owners, stopped sender/recipient, revoked owner and stale generations cannot trigger',async t => {
  for (const action of ['ack','owner','sender','recipient','revoked','generation']) {
    const f = await fixture(t);
    if (action === 'owner') for (const peerId of ['sender','receiver']) await f.call('register_peer',{ peerId,kind: 'chat' },'other');
    const m = f.service.store.putMessage(action === 'owner' ? 'other' : 'owner',input(),1000,'claimed').message;
    if (action === 'ack') await f.call('ack_peer_message',{ messageId: m.messageId,peerId: 'receiver' });
    if (action === 'sender' || action === 'recipient') await f.call('unregister_peer',{ peerId: action === 'sender' ? 'sender' : 'receiver' });
    if (action === 'revoked') f.service.revokeOwner('owner');
    if (action === 'generation') {
      await f.call('unregister_peer',{ peerId: 'receiver' });
      await f.call('register_peer',{ peerId: 'receiver',kind: 'chat' });
    }
    await drain(f.service); assert.equal(f.posts.length,0,action);
  }
});

test('initialization fails closed for absent, local, revoked, wrong-generation and active MCP callback peers',async t => {
  for (const action of ['absent','local','revoked','generation','mcp']) {
    const f = await fixture(t,{ ready: false });
    if (action === 'absent') f.target.peerId = 'missing';
    if (action === 'generation') f.target.generation = 2;
    if (action === 'local') f.service.store.db.prepare("UPDATE peers SET kind='local' WHERE peer_id='receiver'").run();
    if (action === 'revoked') f.service.revokeOwner('owner');
    if (action === 'mcp') f.service.eventStore.activeSubscriptions = () => [{ id: 'fixture',owner: 'owner',name: PEER_EVENT,arguments: { peerId: 'receiver',generation: 1 } }];
    if (['absent','generation'].includes(action)) f.service.webhookWake = new PeerWebhookWake({ store: f.service.store,targets: [f.target],hasMcpCallback: () => false });
    await assert.rejects(f.service.ready(),/Webhook wake target/);
    assert.equal(f.posts.length,0);
  }
});

test('configured target rejects later MCP callback binding and immutable URL/routine rebinding',async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.subscribe('owner',{ name: PEER_EVENT,arguments: { peerId: 'receiver',generation: 1 },
    delivery: { mode: 'webhook',url: 'https://mcp.example',secret: 'whsec_'+randomBytes(32).toString('base64') },ttlMs: 1000 }),/configured webhook/);
  for (const change of ['url','routine']) {
    const target = { ...f.target,...(change === 'routine' ? { routineId: 'other' } : {}) };
    if (change === 'url') await writeFile(f.credentialFile,JSON.stringify({ url: 'https://other.example',token: 'test-secret' }));
    else await writeFile(f.credentialFile,JSON.stringify({ url: 'https://wake.example/routine/mcp',token: 'test-secret' }));
    const adapter = new PeerWebhookWake({ store: f.service.store,targets: [target],hasMcpCallback: () => false });
    await assert.rejects(adapter.ready(),/cannot be rebound/);
  }
  await chmod(f.credentialFile,0o644);
  const invalid = new PeerWebhookWake({ store: f.service.store,targets: [f.target],hasMcpCallback: () => false });
  await assert.rejects(invalid.ready(),/credential file/);
});

test('unregister, revocation and close abort the active notification and prevent further attempts',async t => {
  for (const action of ['unregister','revoke','close']) {
    let started; const begun = new Promise(resolve => { started = resolve; });
    const f = await fixture(t,{ post: async (_url,req) => {
      started(); await new Promise((resolve,reject) => req.signal.addEventListener('abort',() => reject(new CallbackEndpointError('subscription_cancelled')),{ once: true }));
    } });
    const m = f.service.store.putMessage('owner',input(),1000,'claimed').message;
    f.service.store.putMessage('owner',input(),1001,'claimed');
    const flush = drain(f.service); await begun;
    if (action === 'unregister') await f.call('unregister_peer',{ peerId: 'sender' });
    if (action === 'revoke') f.service.revokeOwner('owner');
    if (action === 'close') await f.service.close();
    await flush; assert.equal(f.posts.length,1);
    if (action !== 'close') assert.equal(f.service.store.webhookReceipt('owner',m.messageId).state,'unknown');
  }
});

test('safe client rejects private DNS before exposing bearer credentials',async t => {
  let network = 0;
  const f = await fixture(t);
  f.service.webhookWake.callbackClient = new SafeCallbackClient({ resolve: async () => [{ address: '127.0.0.1',family: 4 }],
    request: () => { network++; throw new Error('must not connect'); } });
  const m = f.service.store.putMessage('owner',input(),1000,'claimed').message;
  await drain(f.service);
  assert.equal(network,0); assert.equal(f.service.store.webhookReceipt('owner',m.messageId).reason,'unsafe_destination');
});


test('normal send automatically starts a notification without delaying durable acceptance or requiring a manual scan',async t => {
  let started,release;
  const begun = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t,{ post: async (_url,req) => { started(); await Promise.race([wait,new Promise(resolve => req.signal.addEventListener('abort',resolve,{ once: true }))]); return { status: 200 }; } });
  t.after(() => release());
  const args = input();
  const r = await f.call('send_peer_message',args);
  assert.equal(r.status,'accepted');
  await begun;
  assert.equal(f.posts.length,1);
  assert.equal(f.service.store.webhookReceipt('owner',args.messageId).state,'claimed');
  release(); await drain(f.service);
  assert.equal((await f.call('get_peer_message',{ messageId: args.messageId })).wakeNotification.state,'webhook_accepted');
});

test('two independent database handles cannot claim the same message twice',async t => {
  const f = await fixture(t);
  const other = new PeerStore(join(f.dir,'peers')); t.after(() => other.close());
  const m = f.service.store.putMessage('owner',input(),1000,'claimed').message;
  assert.ok(other.claimWebhook(f.target,m.messageId,1000));
  assert.equal(f.service.store.claimWebhook(f.target,m.messageId,1000),undefined);
  await drain(f.service); assert.equal(f.posts.length,0);
});


const nativeBinding = { hostId: 'mac',agentId: 'fixture-agent',workspaceId: 'fixture-workspace',cwd: '/fixture',
  serverId: 'fixture-server',requestId: 'existing-request',command: 'node /fixture/peer.mjs' };
async function otherRoutes(f) {
  const nativePosts = [],mcpPosts = [];
  f.options.resolveNative = f.service.resolveNative = async () => nativeBinding;
  f.options.dispatchNative = f.service.dispatchNative = async ({ message }) => {
    nativePosts.push(message.messageId); return { state: 'wake_submitted',requestId: message.requestId };
  };
  for (const peerId of ['sender','inbox']) await f.call('register_peer',{ peerId,kind: 'chat' },'other');
  await f.call('register_peer',{ peerId: 'local',kind: 'local',hostId: 'mac',agentId: 'fixture-agent' },'other');
  const callback = { async post(_url,req) {
    const data = JSON.parse(req.body);
    if (data.type === 'verification') return { status: 200,body: JSON.stringify({ challenge: data.challenge }) };
    mcpPosts.push(data); return { status: 200 };
  } };
  f.service.delivery.callbackClient = callback;
  await f.service.subscribe('other',{ name: PEER_EVENT,arguments: { peerId: 'inbox',generation: 1 },
    delivery: { mode: 'webhook',url: 'https://mcp.example',secret: 'whsec_'+randomBytes(32).toString('base64') },ttlMs: 60000 });
  return { nativePosts,mcpPosts,callback };
}

test('a hanging routine cannot block another owner native dispatch, MCP notification or mailbox read',async t => {
  let started,release;
  const begun = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t,{ post: async (_url,req) => { started(); await Promise.race([wait,new Promise(resolve => req.signal.addEventListener('abort',resolve,{ once: true }))]); return { status: 200 }; } });
  t.after(() => release());
  const routes = await otherRoutes(f);
  const hook = f.service.store.putMessage('owner',input(),1000,'claimed').message;
  const scan = f.service.flushPending(); await begun; await scan;
  assert.equal(f.service.store.webhookReceipt('owner',hook.messageId).state,'claimed');
  const local = await f.call('send_peer_message',input({ toPeerId: 'local' }),'other');
  const inbox = await f.call('send_peer_message',input({ toPeerId: 'inbox' }),'other');
  await f.service.flushPending(); await f.service.flushPending(); await f.service.delivery.flushDue();
  assert.deepEqual(routes.nativePosts,[local.messageId]); assert.equal(routes.mcpPosts.length,1);
  assert.equal(routes.mcpPosts[0].data.messageId,inbox.messageId);
  assert.equal((await f.call('get_peer_message',{ messageId: inbox.messageId },'other')).processingState,'unacknowledged');
  assert.equal(f.service.store.webhookReceipt('owner',hook.messageId).state,'claimed');
  release(); await f.service.webhookWake.flush();
  assert.equal(f.posts.length,1);
});

test('persisted stopped, stale and revoked targets disable on restart without blocking other routes or resetting history',async t => {
  for (const action of ['stopped','generation','revoked']) {
    const f = await fixture(t);
    const routes = await otherRoutes(f);
    const m = f.service.store.putMessage('owner',input(),1000,'claimed').message;
    f.service.store.claimWebhook(f.target,m.messageId,1000);
    const before = f.service.store.webhookBinding(f.target);
    if (action === 'revoked') f.service.revokeOwner('owner');
    else {
      await f.call('unregister_peer',{ peerId: 'receiver' });
      if (action === 'generation') await f.call('register_peer',{ peerId: 'receiver',kind: 'chat' });
    }
    // A retired target should not even need its old credential file to restart.
    await rm(f.credentialFile);
    await f.restart(); f.service.delivery.callbackClient = routes.callback;
    const after = f.service.store.webhookBinding(f.target);
    assert.equal(after.watermark,before.watermark); assert.equal(after.created_at,before.created_at);
    assert.equal(after.disabled_reason,action === 'revoked' ? 'owner_revoked' : action === 'generation' ? 'generation_changed' : 'peer_stopped');
    assert.equal(f.service.store.webhookReceipt('owner',m.messageId).state,'unknown');
    assert.equal(f.service.store.webhookReceipt('owner',m.messageId).claimedAt,1000);
    assert.equal(f.posts.length,0);
    assert.ok((await f.call('list_peers',{},'other')).peers.length);
    assert.equal((await f.call('get_peer_message',{ messageId: m.messageId })).messageId,m.messageId);
    const native = await f.call('send_peer_message',input({ toPeerId: 'local' }),'other');
    const inbox = await f.call('send_peer_message',input({ toPeerId: 'inbox' }),'other');
    await f.service.flushPending(); await f.service.flushPending(); await f.service.delivery.flushDue();
    assert.deepEqual(routes.nativePosts,[native.messageId]); assert.equal(routes.mcpPosts.length,1);
    assert.equal(routes.mcpPosts[0].data.messageId,inbox.messageId);
    assert.equal(f.posts.length,0);
    await f.restart(); assert.equal(f.service.store.webhookBinding(f.target).disabled_reason,after.disabled_reason);
    assert.equal(f.posts.length,0);
  }
});
