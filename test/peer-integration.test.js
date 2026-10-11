import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Webhook } from 'standardwebhooks';
import { createGatewayApp, LocalAgentsOAuthProvider, SCOPE } from '../src/server.js';
import { ATTENTION_EVENT } from '../src/collaboration.js';
import { PEER_TOOLS } from '../src/peer-service.js';
import { runPeerAgent } from '../bin/peer-agent.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'peer-integration-'));
  const cwd = join(dir, 'workspace'); await mkdir(cwd);
  const resource = new URL('https://peer-gateway.example/mcp');
  const provider = new LocalAgentsOAuthProvider({ ownerToken: randomBytes(32).toString('hex'), scopes: [SCOPE],
    allowedRedirectHosts: ['chatgpt.com'], accessTokenTtlSeconds: 60, refreshTokenTtlSeconds: 600 }, resource, dir);
  function identity(name) {
    const client = provider.clientsStore.registerClient({ client_name: name, redirect_uris: ['http://127.0.0.1:9012/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    return { owner: `local-owner:${client.client_id}`, client, token: provider.issueTokens(client.client_id, [SCOPE], resource).access_token };
  }
  const alice = identity('peer alice'), bob = identity('peer bob');
  const tools = JSON.parse(await readFile(new URL('./fixtures/paseo-tools.json', import.meta.url), 'utf8'));
  const snapshots = new Map(), prompts = new Map(), upstreamSends = [], callbacks = [];
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  const runtime = await createGatewayApp({ stateDir: dir, allowedRoots: [cwd], publicBaseUrl: resource.origin }, {
    oauthProvider: provider,
    upstream: { async tools() { return tools; }, async call(name, args) {
      if (name === 'list_workspaces') return { structuredContent: { workspaces: [{ workspaceId: 'wks_peer_test', cwd }] } };
      if (name === 'get_agent_status') {
        const snapshot = snapshots.get(args.agentId);
        if (!snapshot) throw new Error('Unknown fixture agent');
        return { structuredContent: { snapshot: structuredClone(snapshot) } };
      }
      if (name === 'create_agent') {
        const agentId = randomUUID();
        snapshots.set(agentId, { id: agentId, workspaceId: 'wks_peer_test', cwd, status: 'running', activeTurn: { turnId: 'initial-turn' }, pendingPermissions: [] });
        prompts.set(agentId, [args.initialPrompt]); return { structuredContent: { agentId } };
      }
      if (name === 'send_agent_prompt') {
        upstreamSends.push(structuredClone(args)); prompts.get(args.agentId).push(args.prompt);
        const snapshot = snapshots.get(args.agentId); snapshot.status = 'running'; snapshot.activeTurn = { turnId: 'followup-turn' };
        return { structuredContent: { agentId: args.agentId } };
      }
      throw new Error(`Unexpected fixture upstream operation: ${name}`);
    } },
    observerFactory: () => ({ watchAgentIds() {}, start() {}, async close() {} }),
    callbackClient: { async post(url, request) {
      const data = new Webhook(secret).verify(request.body, request.headers);
      if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
      callbacks.push({ url, data }); return { status: 202, body: '{}' };
    } },
  });
  const context = runtime.hosts.get('mac');
  context.gateway.readDaemon = async args => {
    assert.equal(args.action, 'status'); return { available: true, serverId: 'peer-fixture-daemon' };
  };
  runtime.gateway.timeline = async ({ agentId, limit }) => {
    const entries = (prompts.get(agentId) ?? []).map((text, index) => ({ item: { type: 'user_message', text },
      turnId: index === 0 ? 'initial-turn' : 'followup-turn', seqStart: index + 1, seqEnd: index + 1,
      timestamp: new Date(Date.now() + index + 1).toISOString() }));
    return { agentId, agent: structuredClone(snapshots.get(agentId)), entries: limit === 1 ? entries.slice(-1) : entries,
      epoch: 'peer-fixture-epoch', startCursor: { epoch: 'peer-fixture-epoch', seq: 1 },
      endCursor: { epoch: 'peer-fixture-epoch', seq: entries.length }, hasOlder: false, hasNewer: false,
      gap: false, staleCursor: false, reset: false };
  };
  const server = await new Promise(resolve => { const s = runtime.app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); await runtime.close(); await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function rpc(method, params = {}, who = alice) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + who.token, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
    if (method === 'tools/call') headers['mcp-name'] = params.name;
    const response = await fetch(origin + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    assert.equal(response.status, 200); return response.json();
  }
  const call = async (name, args, who = alice) => {
    const result = (await rpc('tools/call', { name, arguments: args }, who)).result;
    assert.equal(result.isError, undefined, result.content?.[0]?.text); return result.structuredContent;
  };
  const denied = async (name, args, who = alice) => {
    const result = (await rpc('tools/call', { name, arguments: args }, who)).result;
    assert.equal(result.isError, true); return result;
  };
  const create = requestId => call('create_agent', { requestId, workspaceId: 'wks_peer_test', title: 'Peer integration fixture',
    provider: 'codex/test', initialPrompt: 'Only this bounded synthetic fixture.' });
  const idle = agentId => Object.assign(snapshots.get(agentId), { status: 'idle', activeTurn: null, pendingPermissions: [] });
  async function cli(agentId, requestId, name, args, expect = 0) {
    let output = '', error = '';
    const rc = await runPeerAgent(['--request-id', requestId, '--tool', name], {
      env: { PASEO_AGENT_ID: agentId }, stateDir: dir, stdin: Readable.from([JSON.stringify(args)]),
      stdout: { write(text) { output += text; } }, stderr: { write(text) { error += text; } },
    });
    assert.equal(rc, expect, error || output);
    const result = output ? JSON.parse(output).result : undefined;
    if (expect === 0) assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return { result, value: result?.structuredContent, error, outputBytes: Buffer.byteLength(output) };
  }
  return { runtime, context, dir, rpc, call, denied, alice, bob, create, idle, snapshots, upstreamSends, callbacks, secret, cli };
}

test('OAuth HTTP peer mailbox registers, persists, reverses replies and isolates owners without host defaults', async t => {
  const f = await fixture(t);
  const catalog = (await f.rpc('tools/list')).result.tools;
  for (const expected of PEER_TOOLS) {
    assert.deepEqual(catalog.find(tool => tool.name === expected.name).inputSchema, expected.inputSchema);
  }
  const first = await f.call('register_peer', { peerId: 'chat-one', kind: 'chat' });
  const second = await f.call('register_peer', { peerId: 'dot-two', kind: 'dot' });
  for (const peer of [first, second]) {
    assert.equal(peer.endpointState, 'mailbox_only'); assert.equal(peer.wakeMode, 'manual');
    assert.equal(Object.hasOwn(peer, 'hostId'), false);
  }
  assert.deepEqual((await f.call('list_peers', {})).peers.map(p => p.peerId).sort(), ['chat-one', 'dot-two']);
  assert.deepEqual((await f.call('list_peers', {}, f.bob)).peers, []);
  await f.call('register_peer', { peerId: 'bob-only', kind: 'chat' }, f.bob);
  await f.denied('send_peer_message', { messageId: randomUUID(), fromPeerId: 'chat-one', toPeerId: 'bob-only', text: 'Cannot cross owner.' });
  const messageId = randomUUID();
  const args = { messageId, fromPeerId: 'chat-one', toPeerId: 'dot-two', text: 'Exact mailbox content.\nSecond line.' };
  const receipt = await f.call('send_peer_message', args);
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.processed, false);
  assert.equal(receipt.processingState, 'unacknowledged'); assert.equal(receipt.senderIdentityAssurance, 'claimed');
  assert.equal(f.runtime.peers.store.getMessage(f.alice.owner, messageId).text, args.text);
  assert.equal((await f.call('get_peer_message', { messageId })).text, args.text);
  assert.deepEqual((await f.call('list_peer_messages', { peerId: 'chat-one' })).messages, []);
  assert.deepEqual((await f.call('list_peer_messages', { peerId: 'dot-two' })).messages.map(m => m.messageId), [messageId]);
  assert.equal((await f.call('get_peer_message', { messageId })).processed, false);
  await f.denied('get_peer_message', { messageId }, f.bob);
  await f.denied('send_peer_message', { ...args, messageId: randomUUID() }, f.bob);
  await f.denied('ack_peer_message', { messageId, peerId: 'dot-two' }, f.bob);
  await f.denied('ack_peer_message', { messageId, peerId: 'chat-one' });
  await f.denied('send_peer_message', { messageId: randomUUID(), fromPeerId: 'chat-one', toPeerId: 'dot-two', text: 'Wrong reply direction', inReplyTo: messageId });
  const replyId = randomUUID();
  const reply = await f.call('send_peer_message', { messageId: replyId, fromPeerId: 'dot-two', toPeerId: 'chat-one', text: 'Exact reverse reply.', inReplyTo: messageId });
  assert.equal(reply.inReplyTo, messageId); assert.equal(reply.rootId, messageId); assert.equal(reply.hop, 1);
  assert.deepEqual((await f.call('list_peer_messages', { peerId: 'chat-one' })).messages.map(m => m.messageId), [replyId]);
  assert.equal((await f.call('send_peer_message', args)).duplicate, true);
  assert.equal((await f.call('ack_peer_message', { messageId, peerId: 'dot-two' })).processingState, 'processed');
  assert.deepEqual((await f.call('list_peer_messages', { peerId: 'dot-two' })).messages, []);
  assert.deepEqual((await f.call('list_peer_messages', { peerId: 'dot-two', includeProcessed: true })).messages.map(m => m.messageId), [messageId]);
  await f.runtime.peers.flushPending();
  assert.equal(f.callbacks.length, 0); assert.equal(f.upstreamSends.length, 0);
  assert.equal(f.runtime.peers.eventStore.listDeliveries().length, 0);
});

test('native busy peer ACK persists immediately; idle wake sends once without old dot route and normal followup retains it', async t => {
  const f = await fixture(t);
  const subscription = (await f.rpc('events/subscribe', { name: ATTENTION_EVENT,
    arguments: { workspaceId: 'wks_peer_test', routeId: 'original-dot-route' },
    delivery: { mode: 'webhook', url: 'https://chatgpt.example/attention', secret: f.secret } })).result;
  assert.ok(subscription.id);
  const created = await f.create('native-route-create'); const agentId = created.agentId;
  // Drain creation's legitimate background timeline read before comparing the
  // whole original record across peer delivery; its route must stay untouched.
  await f.runtime.collaboration.reconcile(agentId);
  const original = f.runtime.collaboration.store.get('native-route-create');
  assert.equal(original.routeId, 'original-dot-route'); assert.equal(original.subscriptionId, subscription.id);
  const local = await f.call('register_peer', { peerId: 'native-one', kind: 'local', hostId: 'mac', agentId });
  assert.equal(local.endpointState, 'native_bound'); assert.ok(local.command);
  await f.call('register_peer', { peerId: 'chat-sender', kind: 'chat' });
  await f.denied('register_peer', { peerId: 'stolen-native', kind: 'local', hostId: 'mac', agentId }, f.bob);
  const messageId = randomUUID();
  const checkAgent = f.context.gateway.checkAgent.bind(f.context.gateway);
  let release, entered = false, timer;
  const blocked = new Promise(resolve => { release = resolve; });
  f.context.gateway.checkAgent = async (...args) => { entered = true; await blocked; return checkAgent(...args); };
  let accepted;
  try {
    accepted = await Promise.race([
      f.call('send_peer_message', { messageId, fromPeerId: 'chat-sender', toPeerId: 'native-one', text: 'Handle this when free.' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Storage acceptance waited for the blocked native check')), 1000); }),
    ]);
    assert.equal(entered, true, 'The background native check must actually be blocked during the ACK');
  } finally { clearTimeout(timer); f.context.gateway.checkAgent = checkAgent; release(); }
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.processed, false);
  await f.runtime.peers.flushPending();
  const queued = await f.call('get_peer_message', { messageId });
  assert.equal(queued.deliveryState, 'queued'); assert.ok(queued.requestId.startsWith('peer.'));
  assert.equal(f.upstreamSends.length, 0);
  assert.equal(f.context.store.get(queued.requestId), undefined);
  assert.equal(f.runtime.collaboration.store.get(queued.requestId), undefined);
  assert.deepEqual(f.runtime.collaboration.store.get('native-route-create'), original);
  f.idle(agentId);
  await f.runtime.peers.flushPending();
  assert.equal(f.upstreamSends.length, 1);
  const dispatched = f.context.store.get(queued.requestId);
  assert.equal(dispatched.state, 'submitted'); assert.equal(dispatched.tool, 'send_agent_prompt');
  const peerRecord = f.runtime.collaboration.store.get(queued.requestId);
  assert.equal(peerRecord.routeId, null); assert.equal(peerRecord.subscriptionId, null);
  assert.equal(peerRecord.owner, f.alice.owner);
  await f.runtime.peers.flushPending(); await f.runtime.peers.flushPending();
  assert.equal(f.upstreamSends.length, 1);
  assert.equal((await f.call('get_peer_message', { messageId })).requestId, queued.requestId);
  assert.deepEqual(f.runtime.collaboration.store.get('native-route-create'), original);
  await f.denied('send_agent_prompt', { requestId: 'peer.external-reserved', agentId, prompt: 'Do not submit this.' });
  await f.denied('create_agent', { requestId: 'peer.external-create', workspaceId: 'wks_peer_test', title: 'reserved', provider: 'codex/test', initialPrompt: 'Do not create this.' });
  assert.equal(f.upstreamSends.length, 1);
  f.idle(agentId);
  const normal = await f.call('send_agent_prompt', { requestId: 'normal-after-peer', agentId, prompt: 'Normal original-route followup.' });
  assert.equal(normal.state, 'submitted'); assert.equal(f.upstreamSends.length, 2);
  const normalRecord = f.runtime.collaboration.store.get('normal-after-peer');
  assert.equal(normalRecord.routeId, 'original-dot-route'); assert.equal(normalRecord.subscriptionId, subscription.id);
});

test('real Unix CLI self-registers and reads, replies and ACKs only its authenticated native peer', async t => {
  const f = await fixture(t);
  const created = await f.create('cli-peer-create'); const agentId = created.agentId;
  await f.context.channel.issue(agentId);
  const registered = await f.cli(agentId, 'cli-peer-create', 'register_peer', { peerId: 'cli-native' });
  assert.equal(registered.value.kind, 'local'); assert.equal(registered.value.hostId, 'mac'); assert.equal(registered.value.agentId, agentId);
  assert.equal(registered.value.senderIdentityAssurance, 'native_capability');
  await f.call('register_peer', { peerId: 'chat-cli', kind: 'chat' });
  assert.deepEqual((await f.cli(agentId, 'cli-peer-create', 'list_peers', {})).value.peers.map(p => p.peerId).sort(), ['chat-cli', 'cli-native']);
  const messageId = randomUUID();
  await f.call('send_peer_message', { messageId, fromPeerId: 'chat-cli', toPeerId: 'cli-native', text: 'CLI mailbox exact content.' });
  assert.equal((await f.cli(agentId, 'cli-peer-create', 'get_peer_message', { messageId })).value.text, 'CLI mailbox exact content.');
  assert.deepEqual((await f.cli(agentId, 'cli-peer-create', 'list_peer_messages', {})).value.messages.map(m => m.messageId), [messageId]);
  const replyId = randomUUID();
  const reply = await f.cli(agentId, 'cli-peer-create', 'send_peer_message', { messageId: replyId, toPeerId: 'chat-cli', text: 'CLI reverse reply.', inReplyTo: messageId });
  assert.equal(reply.value.fromPeerId, 'cli-native'); assert.equal(reply.value.senderIdentityAssurance, 'native_capability');
  assert.equal((await f.call('get_peer_message', { messageId: replyId })).text, 'CLI reverse reply.');
  assert.equal((await f.cli(agentId, 'cli-peer-create', 'ack_peer_message', { messageId })).value.processed, true);
  assert.deepEqual((await f.cli(agentId, 'cli-peer-create', 'list_peer_messages', {})).value.messages, []);
  assert.equal((await f.cli(agentId, 'cli-peer-create', 'send_peer_message', { messageId: randomUUID(), fromPeerId: 'chat-cli', toPeerId: 'cli-native', text: 'Spoofed sender.' }, 1)).result.isError, true);
  assert.equal((await f.cli(agentId, 'cli-peer-create', 'list_peer_messages', { peerId: 'chat-cli' }, 1)).result.isError, true);
  const denied = await f.cli(agentId, 'unowned-original-request', 'list_peers', {}, 1);
  assert.equal(denied.result, undefined); assert.match(denied.error, /rejected/);
  assert.equal(f.upstreamSends.length, 0);
});

test('real Unix CLI lists 100 maximum-sized messages below its response limit and exact get survives ACK', async t => {
  const f = await fixture(t);
  const created = await f.create('cli-large-inbox-create'); const agentId = created.agentId;
  await f.context.channel.issue(agentId);
  await f.cli(agentId, 'cli-large-inbox-create', 'register_peer', { peerId: 'large-inbox-native' });
  await f.call('register_peer', { peerId: 'large-inbox-chat', kind: 'chat' });
  const sent = [];
  for (let index = 0; index < 100; index++) {
    const prefix = `Maximum message ${String(index).padStart(3, '0')}: `;
    const message = { messageId: randomUUID(), fromPeerId: 'large-inbox-chat', toPeerId: 'large-inbox-native',
      text: prefix + 'A'.repeat(8192 - prefix.length) };
    await f.call('send_peer_message', message); sent.push(message);
  }
  const listed = await f.cli(agentId, 'cli-large-inbox-create', 'list_peer_messages', { limit: 100 });
  t.diagnostic(`Actual Unix CLI inbox response: ${listed.outputBytes} bytes for 100 messages with 8192 ASCII characters each`);
  assert.equal(listed.value.messages.length, 100);
  assert.ok(listed.outputBytes < 512 * 1024, `Actual Unix response was ${listed.outputBytes} bytes`);
  assert.deepEqual(listed.value.messages.map(m => m.messageId).sort(), sent.map(m => m.messageId).sort());
  for (const row of listed.value.messages) {
    const exact = sent.find(m => m.messageId === row.messageId);
    assert.equal(Object.hasOwn(row, 'text'), false); assert.equal(Object.hasOwn(row, 'deliveries'), false);
    assert.equal(row.summary, exact.text.slice(0, 200)); assert.equal(row.textLength, 8192);
    assert.equal(row.processed, false);
  }
  const target = sent[57];
  const fetched = await f.cli(agentId, 'cli-large-inbox-create', 'get_peer_message', { messageId: target.messageId });
  assert.equal(fetched.value.text, target.text); assert.equal(fetched.value.text.length, 8192);
  await f.cli(agentId, 'cli-large-inbox-create', 'ack_peer_message', { messageId: target.messageId });
  const afterAck = await f.cli(agentId, 'cli-large-inbox-create', 'get_peer_message', { messageId: target.messageId });
  assert.equal(afterAck.value.text, target.text); assert.equal(afterAck.value.processed, true);
  const pending = await f.cli(agentId, 'cli-large-inbox-create', 'list_peer_messages', { limit: 100 });
  assert.equal(pending.value.messages.length, 99); assert.ok(!pending.value.messages.some(m => m.messageId === target.messageId));
  const history = await f.cli(agentId, 'cli-large-inbox-create', 'list_peer_messages', { limit: 100, includeProcessed: true });
  assert.equal(history.value.messages.length, 100); assert.ok(history.outputBytes < 512 * 1024);
  assert.equal(f.upstreamSends.length, 0);
});
