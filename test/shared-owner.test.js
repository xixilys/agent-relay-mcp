import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { createGatewayApp, LocalAgentsOAuthProvider, SCOPE } from '../src/server.js';
import { SHARED_OWNER, createOwnerPolicy } from '../src/shared-owner.js';
import { PEER_EVENT } from '../src/peer-service.js';

test('shared owner is explicit and validates configuration and authenticated identity', () => {
  assert.equal(createOwnerPolicy().ownerForClient('a'), 'local-owner:a');
  assert.equal(createOwnerPolicy({ sharedOwner: false }).ownerForClient('b'), 'local-owner:b');
  assert.equal(createOwnerPolicy({ sharedOwner: true }).ownerForClient('a'), SHARED_OWNER);
  for (const value of ['true', null, 1, {}]) assert.throws(() => createOwnerPolicy({ sharedOwner: value }), /boolean/);
  for (const value of ['', null, undefined]) assert.throws(() => createOwnerPolicy({ sharedOwner: true }).ownerForClient(value), /Authenticated/);
});

async function fixture(t, sharedOwner) {
  const dir = await mkdtemp(join(tmpdir(), 'shared-owner-'));
  const resource = new URL('https://shared-gateway.example/mcp');
  const provider = new LocalAgentsOAuthProvider({ ownerToken: randomBytes(32).toString('hex'), scopes: [SCOPE],
    allowedRedirectHosts: ['chatgpt.com'], accessTokenTtlSeconds: 60, refreshTokenTtlSeconds: 600 }, resource, dir);
  const identity = name => {
    const client = provider.clientsStore.registerClient({ client_name: name, redirect_uris: ['http://127.0.0.1:9012/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    return { client, token: provider.issueTokens(client.client_id, [SCOPE], resource) };
  };
  const alice = identity('alice'), bob = identity('bob');
  const tools = JSON.parse(await readFile(new URL('./fixtures/paseo-tools.json', import.meta.url), 'utf8'));
  const runtime = await createGatewayApp({ stateDir: dir, allowedRoots: [dir], publicBaseUrl: resource.origin,
    ...(sharedOwner === undefined ? {} : { sharedOwner }) }, {
    oauthProvider: provider, upstream: { async tools() { return tools; } },
    observerFactory: () => ({ watchAgentIds() {}, start() {}, async close() {} }),
    callbackClient: { async post(_url, request) {
      const data = JSON.parse(request.body);
      return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    } },
  });
  const server = await new Promise(resolve => { const s = runtime.app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function rpc(who, method, params, modern = true) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + who.token.access_token };
    if (modern) Object.assign(headers, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}) });
    const response = await fetch(origin + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method,
      params: { ...params, ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }) });
    return { status: response.status, ...await response.json() };
  }
  const call = async (who, name, args, modern) => (await rpc(who, 'tools/call', { name, arguments: args }, modern)).result;
  const revoke = async who => {
    const response = await fetch(origin + '/revoke', { method: 'POST', body: new URLSearchParams({ client_id: who.client.client_id, token: who.token.access_token }) });
    assert.equal(response.status, 200);
  };
  return { runtime, alice, bob, rpc, call, revoke };
}

for (const shared of [undefined, true]) test(`actual OAuth HTTP mailbox and revocation with sharedOwner=${shared}`, async t => {
  const f = await fixture(t, shared);
  await f.call(f.alice, 'register_peer', { peerId: 'alice', kind: 'chat' });
  const listed = await f.call(f.bob, 'list_peers', {}, false);
  assert.equal(listed.structuredContent.peers.length, shared ? 1 : 0);
  const owner = shared ? SHARED_OWNER : `local-owner:${f.alice.client.client_id}`;
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  const subscribed = await f.rpc(f.alice, 'events/subscribe', { name: PEER_EVENT, arguments: { peerId: 'alice', generation: 1 },
    delivery: { mode: 'webhook', url: 'https://callback.example/alice', secret } });
  assert.ok(subscribed.result.id);
  if (shared) {
    await f.call(f.bob, 'register_peer', { peerId: 'bob', kind: 'dot' }, false);
    const messageId = randomUUID();
    await f.call(f.bob, 'send_peer_message', { messageId, fromPeerId: 'bob', toPeerId: 'alice', text: 'Cross-client message.' });
    assert.equal((await f.call(f.alice, 'get_peer_message', { messageId }, false)).structuredContent.text, 'Cross-client message.');
    const replyId = randomUUID();
    await f.call(f.alice, 'send_peer_message', { messageId: replyId, fromPeerId: 'alice', toPeerId: 'bob', text: 'Cross-client reply.', inReplyTo: messageId });
    assert.equal((await f.call(f.bob, 'get_peer_message', { messageId: replyId })).structuredContent.text, 'Cross-client reply.');
  }
  await f.revoke(f.alice);
  assert.equal((await f.rpc(f.alice, 'tools/list', {})).status, 401);
  assert.equal((await f.rpc(f.bob, 'tools/list', {})).status, 200);
  assert.equal(f.runtime.peers.eventStore.activeSubscriptions({ owner }).length, shared ? 1 : 0);
  assert.equal(f.runtime.peers.store.listPeers(owner).filter(p => p.state === 'active').length, shared ? 2 : 0);
  if (shared) {
    await f.call(f.bob, 'send_peer_message', { messageId: randomUUID(), fromPeerId: 'bob', toPeerId: 'alice', text: 'Still usable after one client revokes.' });
    await f.runtime.peers.delivery.flushDue();
    assert.ok(f.runtime.peers.eventStore.listDeliveries().some(row => row.state === 'received'));
  }
});
