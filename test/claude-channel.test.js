import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, lstat, symlink, unlink, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { PeerService } from '../src/peer-service.js';
import { createClaudeChannel } from '../src/claude-channel.js';
import { createGatewayApp, LocalAgentsOAuthProvider, SCOPE } from '../src/server.js';
import { runClaudeChannel } from '../bin/claude-channel.mjs';

async function until(predicate) {
  const deadline = Date.now()+5000;
  while (!predicate()) { if (Date.now()>deadline) throw Error('test_wait_timeout'); await new Promise(resolve => setTimeout(resolve,10)); }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'claude-channel-'));
  const peers = new PeerService({ stateDir: dir });
  const call = (name,args,owner = 'owner') => peers.call(name,args,{ owner });
  for (const peerId of ['pro','claude','other']) await call('register_peer',{ peerId,kind: 'chat' });
  const binding = { owner: 'owner',peerId: 'claude',generation: 1 };
  const channel = createClaudeChannel({ stateDir: dir,binding,peers }); await channel.listen();
  const clients = [];
  t.after(async () => { for (const client of clients) client.destroy(); await channel.close(); await peers.close(); await rm(dir,{ recursive: true,force: true }); });
  const send = (extra = {}) => call('send_peer_message',{ messageId: randomUUID(),fromPeerId: 'pro',toPeerId: 'claude',text: 'private exact text',...extra });
  const connect = async (sessionId = randomUUID()) => {
    const response = await new Promise((resolve,reject) => { const req = http.get({ socketPath: channel.socketPath,path: '/events',headers: { 'x-claude-session': sessionId } },resolve); req.once('error',reject); clients.push(req); });
    const frames = [],controls = []; let buffer = '';
    response.on('data',chunk => { buffer += chunk; let i; while ((i=buffer.indexOf('\n\n')) !== -1) { const frame = buffer.slice(0,i); buffer=buffer.slice(i+2); const type = /^event: (.+)$/m.exec(frame)?.[1]; if (type) (['ready','message'].includes(type) ? frames : controls).push({ type,data: JSON.parse(/^data: (.+)$/m.exec(frame)[1]) }); } });
    response.on('error',() => {}); clients.push(response);
    return { response,frames,controls,sessionId };
  };
  const tool = async (sessionId,name,args) => {
    const body = JSON.stringify({ name,arguments: args });
    return new Promise((resolve,reject) => {
      const req = http.request({ socketPath: channel.socketPath,path: '/tool',method: 'POST',headers: { 'x-claude-session': sessionId,'content-length': Buffer.byteLength(body) } },response => {
        let body = ''; response.on('data',chunk => { body+=chunk; }); response.on('end',() => resolve({ status: response.statusCode,...JSON.parse(body) }));
      }); req.once('error',reject); req.end(body);
    });
  };
  return { dir,peers,call,binding,channel,send,connect,tool };
}

test('durable replay, live push, exact read and linked reply preserve mailbox semantics',async t => {
  const { send,connect,tool,peers } = await fixture(t);
  const original = await send();
  await peers.flushPending(); // Replay includes already event-recorded messages.
  const a = await connect(); await until(() => a.frames.length === 2);
  assert.equal(a.frames[1].data.messageId,original.messageId);
  assert.equal(JSON.stringify(a.frames).includes('private exact text'),false);
  assert.equal(peers.store.getMessage('owner',original.messageId).processedAt,null);
  const read = await tool(a.sessionId,'get_peer_message',{ messageId: original.messageId });
  assert.equal(read.result.text,'private exact text');
  const replyId = randomUUID();
  const replyArgs = { messageId: replyId,fromPeerId: 'claude',toPeerId: 'pro',text: 'reply',inReplyTo: original.messageId };
  assert.equal((await tool(a.sessionId,'send_peer_message',replyArgs)).result.senderIdentityAssurance,'claimed');
  assert.equal((await tool(a.sessionId,'send_peer_message',replyArgs)).result.duplicate,true);
  assert.equal((await tool(a.sessionId,'send_peer_message',{ ...replyArgs,messageId: randomUUID() })).isError,true);
  const outbox = await tool(a.sessionId,'list_peer_messages',{ peerId: 'claude',direction: 'outbox',includeProcessed: true });
  assert.equal(outbox.result.messages[0].messageId,replyId);
  assert.equal((await tool(a.sessionId,'get_peer_message',{ messageId: replyId })).result.text,'reply');
  assert.equal((await tool(a.sessionId,'ack_peer_message',{ peerId: 'claude',messageId: replyId })).isError,true);
  await tool(a.sessionId,'ack_peer_message',{ peerId: 'claude',messageId: original.messageId });
  const live = await send(); await until(() => a.frames.length === 3);
  assert.equal(a.frames[2].data.messageId,live.messageId);
  a.response.destroy(); await until(() => a.response.destroyed); await new Promise(resolve => setTimeout(resolve,20));
  const b = await connect(); await until(() => b.frames.length === 2);
  assert.equal(b.frames[1].data.messageId,live.messageId);
  assert.equal((await tool(a.sessionId,'send_peer_message',replyArgs)).status,403);
});

test('fixed binding rejects cross-peer, old generation, arbitrary tools and concurrent consumer',async t => {
  const { call,send,connect,tool } = await fixture(t);
  const stale = await send();
  await call('unregister_peer',{ peerId: 'claude' }); await call('register_peer',{ peerId: 'claude',kind: 'chat' });
  // The original configured generation remains invalid rather than rebinding.
  const failed = await connect(); assert.equal(failed.response.statusCode,403);
  assert.equal((await tool(randomUUID(),'get_peer_message',{ messageId: stale.messageId })).status,403);
});

test('one live consumer cannot steal a binding and own-generation reads exclude other peers',async t => {
  const { call,send,connect,tool } = await fixture(t);
  const other = await send({ toPeerId: 'other' });
  const a = await connect(); await until(() => a.frames.length === 1);
  const b = await connect(); assert.equal(b.response.statusCode,409);
  assert.equal((await tool(a.sessionId,'get_peer_message',{ messageId: other.messageId })).isError,true);
  assert.equal((await tool(a.sessionId,'list_peer_messages',{ peerId: 'pro' })).isError,true);
  assert.equal((await tool(a.sessionId,'send_peer_message',{ messageId: randomUUID(),fromPeerId: 'pro',toPeerId: 'other',text: 'forged' })).isError,true);
  assert.equal((await tool(a.sessionId,'register_peer',{ peerId: 'new',kind: 'chat' })).isError,true);
  assert.equal((await tool(a.sessionId,'get_peer_message',{ messageId: other.messageId,owner: 'other-owner' })).isError,true);
  await call('unregister_peer',{ peerId: 'claude' }); await until(() => a.response.destroyed);
  assert.equal((await tool(a.sessionId,'list_peer_messages',{ peerId: 'claude' })).status,403);
});

test('revocation closes push immediately and prevents disconnected adapter tools',async t => {
  const { peers,connect,tool } = await fixture(t);
  const a = await connect(); await until(() => a.frames.length === 1);
  peers.revokeOwner('owner'); await until(() => a.response.destroyed);
  assert.equal((await tool(a.sessionId,'list_peer_messages',{ peerId: 'claude',includeProcessed: true })).status,403);
});

test('service shutdown closes the stream before database close and a broken consumer cannot undo acceptance',async t => {
  const { peers,send,connect,tool } = await fixture(t);
  peers.subscribeChannel(() => { throw Error('consumer failure'); });
  assert.equal((await send()).status,'accepted');
  const a = await connect(); await until(() => a.frames.length === 2);
  await peers.close(); await until(() => a.response.destroyed);
  assert.equal((await tool(a.sessionId,'list_peer_messages',{ peerId: 'claude' })).status,403);
});

test('a newly configured generation cannot read prior inbox/outbox or processed history',async t => {
  const { peers,channel,dir,call,send,connect,tool } = await fixture(t);
  const old = await send();
  const out = await send({ fromPeerId: 'claude',toPeerId: 'pro' });
  await call('ack_peer_message',{ messageId: old.messageId,peerId: 'claude' });
  await call('unregister_peer',{ peerId: 'claude' }); await call('register_peer',{ peerId: 'claude',kind: 'chat' });
  await channel.close();
  const next = createClaudeChannel({ stateDir: dir,binding: { owner: 'owner',peerId: 'claude',generation: 2 },peers });
  try {
    await next.listen(); const a = await connect(); await until(() => a.frames.length === 1);
    for (const direction of ['inbox','outbox']) assert.deepEqual((await tool(a.sessionId,'list_peer_messages',{ peerId: 'claude',direction,includeProcessed: true })).result.messages,[]);
    for (const messageId of [old.messageId,out.messageId]) assert.equal((await tool(a.sessionId,'get_peer_message',{ messageId })).isError,true);
  } finally { await next.close(); }
});

test('replay covers more than 100 messages and skips processed, cancelled or stopped senders',async t => {
  const { peers,call,send,connect } = await fixture(t);
  const expected = [];
  for (let i=0;i<120;i++) expected.push((await send()).messageId);
  const cancelled = await send(); peers.store.setDelivery('owner',cancelled.messageId,'cancelled');
  const processed = await send(); await call('ack_peer_message',{ messageId: processed.messageId,peerId: 'claude' });
  await call('register_peer',{ peerId: 'stopped',kind: 'chat' }); await send({ fromPeerId: 'stopped' }); await call('unregister_peer',{ peerId: 'stopped' });
  const a = await connect(); await until(() => a.frames.length === 121);
  assert.deepEqual(a.frames.slice(1).map(f => f.data.messageId),expected);
  await peers.flushPending(); await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(a.frames.length,121);
});

test('socket lifecycle preserves other live instance, symlinks and replacement files',async t => {
  const { dir,binding,peers,channel } = await fixture(t);
  assert.equal((await lstat(dir)).mode & 0o777,0o700);
  assert.equal((await lstat(channel.socketPath)).mode & 0o777,0o600);
  const second = createClaudeChannel({ stateDir: dir,binding,peers });
  await assert.rejects(second.listen(),/channel_already_listening/); await second.close();
  assert.ok((await lstat(channel.socketPath)).isSocket());
  await unlink(channel.socketPath); await writeFile(channel.socketPath,'replacement');
  await channel.close(); assert.equal(await readFile(channel.socketPath,'utf8'),'replacement');
  await unlink(channel.socketPath); await symlink(join(dir,'elsewhere'),channel.socketPath);
  const third = createClaudeChannel({ stateDir: dir,binding,peers });
  await assert.rejects(third.listen(),/unsafe_existing_socket/); await third.close();
  assert.ok((await lstat(channel.socketPath)).isSymbolicLink());
});

test('a healthy reader drains a backlog exceeding the buffer and receives concurrent live sends once',async t => {
  const { peers,send,connect } = await fixture(t);
  const ids = [];
  for (let i=0;i<1500;i++) {
    const messageId = randomUUID(); ids.push(messageId);
    peers.store.putMessage('owner',{ messageId,fromPeerId: 'pro',toPeerId: 'claude',text: 'large backlog' },Date.now(),'claimed');
  }
  const a = await connect();
  const live = await send(); ids.push(live.messageId);
  await until(() => a.controls.some(f => f.type === 'replay_complete') && a.frames.length === 1502);
  assert.deepEqual(new Set(a.frames.slice(1).map(f => f.data.messageId)),new Set(ids));
  assert.equal(a.response.destroyed,false);
});

test('a stalled reader disconnects after bounded backpressure and loses its tool lease',async t => {
  const { peers,channel,tool } = await fixture(t);
  for (let i=0;i<3000;i++) peers.store.putMessage('owner',{ messageId: randomUUID(),fromPeerId: 'pro',toPeerId: 'claude',text: 'stalled backlog' },Date.now(),'claimed');
  const sessionId = randomUUID();
  const response = await new Promise((resolve,reject) => {
    const request = http.get({ socketPath: channel.socketPath,path: '/events',headers: { 'x-claude-session': sessionId } },resolve); request.once('error',reject);
  });
  response.on('error',() => {}); response.pause(); t.after(() => response.destroy());
  await new Promise(resolve => setTimeout(resolve,5500));
  assert.equal((await tool(sessionId,'list_peer_messages',{ peerId: 'claude' })).status,403);
});

test('standalone stdio MCP handshake emits channel notifications and exposes two-way bounded tools',async t => {
  const { channel,send,peers } = await fixture(t);
  const incoming = await send();
  const transport = new StdioClientTransport({ command: process.execPath,args: [fileURLToPath(new URL('../bin/claude-channel.mjs',import.meta.url)),'--socket',channel.socketPath],stderr: 'pipe' });
  const client = new Client({ name: 'channel-contract-test',version: '1' },{ capabilities: {} });
  const notifications = [];
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'),params: z.object({ content: z.string(),meta: z.record(z.string(),z.string()) }) }),n => { notifications.push(n); });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.deepEqual(client.getServerCapabilities().experimental,{ 'claude/channel': {} });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(),['ack_peer_message','get_peer_message','list_peer_messages','send_peer_message']);
  await until(() => notifications.length === 1);
  assert.equal(notifications[0].params.meta.message_id,incoming.messageId);
  assert.ok(!notifications[0].params.content.includes('private exact text'));
  const read = await client.callTool({ name: 'get_peer_message',arguments: { messageId: incoming.messageId } });
  assert.equal(JSON.parse(read.content[0].text).text,'private exact text');
  const reply = await client.callTool({ name: 'send_peer_message',arguments: { messageId: randomUUID(),fromPeerId: 'claude',toPeerId: 'pro',inReplyTo: incoming.messageId,text: 'stdio reply' } });
  assert.equal(JSON.parse(reply.content[0].text).status,'accepted');
  assert.equal(peers.store.getMessage('owner',incoming.messageId).processedAt,null);
  const live = await send(); await until(() => notifications.length === 2);
  assert.equal(notifications[1].params.meta.message_id,live.messageId);
  await client.callTool({ name: 'ack_peer_message',arguments: { messageId: incoming.messageId,peerId: 'claude' } });
  assert.notEqual(peers.store.getMessage('owner',incoming.messageId).processedAt,null);
});

test('one spawned stdio adapter survives initial missing socket and gateway restart without retrying tool writes',async t => {
  const dir = await mkdtemp(join(tmpdir(),'cc-reconnect-'));
  const socketPath = join(dir,'claude-channel.sock');
  const binding = { owner: 'owner',peerId: 'claude',generation: 1 };
  let peers = new PeerService({ stateDir: dir }),channel;
  for (const peerId of ['pro','claude']) await peers.call('register_peer',{ peerId,kind: 'chat' },{ owner: 'owner' });
  await peers.close();
  const transport = new StdioClientTransport({ command: process.execPath,args: [fileURLToPath(new URL('../bin/claude-channel.mjs',import.meta.url)),'--socket',socketPath],stderr: 'pipe' });
  const client = new Client({ name: 'reconnect-test',version: '1' },{ capabilities: {} });
  const notifications = []; let stderr = '';
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'),params: z.object({ content: z.string(),meta: z.record(z.string(),z.string()) }) }),n => { notifications.push(n); });
  t.after(async () => { await client.close(); await channel?.close(); await peers.close(); await rm(dir,{ recursive: true,force: true }); });
  await client.connect(transport); transport.stderr.on('data',chunk => { stderr += chunk; });
  const originalPid = transport.pid;
  const pendingTools = client.listTools();
  await until(() => stderr.includes('startup_socket_missing'));
  const open = async () => {
    peers = new PeerService({ stateDir: dir }); await peers.ready();
    channel = createClaudeChannel({ stateDir: dir,binding,peers }); await channel.listen();
  };
  await open(); await pendingTools;
  const incoming = { messageId: randomUUID(),fromPeerId: 'pro',toPeerId: 'claude',text: 'exact reconnect test' };
  await peers.call('send_peer_message',incoming,{ owner: 'owner' }); await until(() => notifications.length === 1);
  const replyId = randomUUID();
  await client.callTool({ name: 'send_peer_message',arguments: { messageId: replyId,fromPeerId: 'claude',toPeerId: 'pro',text: 'stable reply',inReplyTo: incoming.messageId } });
  await channel.close(); await peers.close();
  await until(() => stderr.includes('connection_reset') || stderr.includes('sse_closed'));
  await open(); await until(() => (stderr.match(/event_stream_connected/g) ?? []).length === 2);
  assert.equal(transport.pid,originalPid);
  // The unACKed original replays durably, but this running MCP adapter dedups it.
  assert.equal(notifications.length,1);
  const recovery = await client.callTool({ name: 'get_peer_message',arguments: { messageId: replyId } });
  assert.equal(JSON.parse(recovery.content[0].text).text,'stable reply');
  assert.equal(peers.store.db.prepare('SELECT COUNT(*) AS count FROM peer_messages WHERE owner=? AND from_peer_id=?').get('owner','claude').count,1);
  const fresh = await peers.call('send_peer_message',{ ...incoming,messageId: randomUUID(),text: 'after restart' },{ owner: 'owner' });
  await until(() => notifications.length === 2); assert.equal(notifications[1].params.meta.message_id,fresh.messageId);
  await client.callTool({ name: 'ack_peer_message',arguments: { peerId: 'claude',messageId: fresh.messageId } });
  assert.notEqual(peers.store.getMessage('owner',fresh.messageId).processedAt,null);
  await client.close(); await until(() => stderr.includes('stdin_eof') || stderr.includes('signal_sigterm'));
  for (const line of stderr.trim().split('\n')) {
    const diagnostic = JSON.parse(line);
    assert.deepEqual(Object.keys(diagnostic).sort(),diagnostic.httpStatus === undefined ? ['at','event','reason'] : ['at','event','httpStatus','reason']);
    assert.equal(diagnostic.event,'claude_channel_lifecycle'); assert.ok(Number.isFinite(Date.parse(diagnostic.at)));
  }
  assert.equal(stderr.includes(dir),false); assert.equal(stderr.includes(incoming.messageId),false); assert.equal(stderr.includes(incoming.text),false);
});

test('startup rejects unsafe directory permissions and socket symlinks with fixed diagnostics',async t => {
  const dir = await mkdtemp(join(tmpdir(),'cc-unsafe-')); t.after(() => rm(dir,{ recursive: true,force: true }));
  const socketPath = join(dir,'claude-channel.sock');
  for (const kind of ['directory','symlink']) {
    if (kind === 'directory') await chmod(dir,0o755);
    else { await chmod(dir,0o700); await symlink(join(dir,'missing'),socketPath); }
    const child = spawn(process.execPath,[fileURLToPath(new URL('../bin/claude-channel.mjs',import.meta.url)),'--socket',socketPath]);
    let stdout = '',stderr = ''; child.stdout.on('data',chunk => { stdout += chunk; }); child.stderr.on('data',chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.once('close',resolve));
    assert.equal(code,1); assert.equal(stdout,''); assert.equal(JSON.parse(stderr.trim()).reason,'unsafe_socket');
    assert.equal(stderr.includes(dir),false);
  }
});

test('closed resolves once after stdio EOF cleanup and repeated close preserves its fixed reason',async t => {
  const { channel } = await fixture(t);
  const input = new PassThrough(),output = new PassThrough();
  const runtime = await runClaudeChannel({ socketPath: channel.socketPath,input,output });
  let completions = 0; runtime.closed.then(() => { completions++; });
  input.end();
  const result = await runtime.closed;
  assert.deepEqual(result,{ reason: 'stdin_eof',status: undefined });
  assert.equal(input.listenerCount('data'),0);
  await Promise.all([runtime.close(),runtime.close('signal_sigterm')]);
  assert.equal(await runtime.closed,result); assert.equal(completions,1);
  output.destroy();
});

test('gateway opt-in lifecycle isolates inactive bindings and cleans all sockets on malformed startup',async t => {
  const dir = await mkdtemp(join(tmpdir(),'cc-gateway-')); const cwd = join(dir,'workspace'); await mkdir(cwd);
  t.after(() => rm(dir,{ recursive: true,force: true }));
  const seed = new PeerService({ stateDir: dir });
  await seed.call('register_peer',{ peerId: 'claude',kind: 'chat' },{ owner: 'local-owner:shared' }); await seed.close();
  const resource = new URL('https://channel-gateway.example/mcp');
  const config = { stateDir: dir,allowedRoots: [cwd],publicBaseUrl: resource.origin,sharedOwner: true,
    claudeChannel: { owner: 'local-owner:shared',peerId: 'claude',generation: 1 } };
  const tools = JSON.parse(await readFile(new URL('./fixtures/paseo-tools.json',import.meta.url),'utf8'));
  const options = () => ({
    oauthProvider: new LocalAgentsOAuthProvider({ ownerToken: 'test-channel-owner-token'.padEnd(64,'x'),scopes: [SCOPE],
      allowedRedirectHosts: ['chatgpt.com'],accessTokenTtlSeconds: 60,refreshTokenTtlSeconds: 600 },resource,dir),
    upstream: { async tools() { return tools; },async call() { throw Error('Unexpected upstream call'); } },
    observerFactory: () => ({ watchAgentIds() {},start() {},async close() {} }),
  });
  const runtime = await createGatewayApp(config,options());
  assert.ok(runtime.claudeChannel); assert.ok((await lstat(join(dir,'claude-channel.sock'))).isSocket());
  await runtime.close();
  await assert.rejects(lstat(join(dir,'claude-channel.sock')),{ code: 'ENOENT' });
  const inactive = await createGatewayApp({ ...config,claudeChannel: { ...config.claudeChannel,generation: 2 } },options());
  assert.equal(inactive.claudeChannel.state,'binding_inactive');
  const status = await new Promise((resolve,reject) => { const request = http.get({ socketPath: inactive.claudeChannel.socketPath,path: '/events',headers: { 'x-claude-session': randomUUID() } },response => { response.resume(); resolve(response.statusCode); }); request.once('error',reject); });
  assert.equal(status,403); assert.ok((await inactive.gateway.refreshTools()).length > 0);
  await inactive.close();
  await assert.rejects(createGatewayApp({ ...config,claudeChannel: { ...config.claudeChannel,generation: 0 } },options()),/invalid_claude_channel_binding/);
  for (const name of ['claude-channel.sock','agent-channel.sock']) await assert.rejects(lstat(join(dir,name)),{ code: 'ENOENT' });
});
