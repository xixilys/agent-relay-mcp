import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, lstat, chmod, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createAgentChannel, readAgentCapability, validatePeerRequest } from '../src/agent-channel.js';
import { runPeerAgent } from '../bin/peer-agent.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const actor = { owner: 'synthetic-owner', hostId: 'mac', agentId: A, peerId: 'native-one' };
const rpc = (name = 'list_peers', args = {}) => ({ jsonrpc: '2.0', id: 'request-one', method: 'tools/call', params: { name, arguments: args } });
const body = (overrides = {}) => ({ agentId: A, requestId: 'request-one', rpc: rpc(), ...overrides });
function outputs() {
  const result = { stdout: '', stderr: '' };
  return { result, stdout: { write: text => { result.stdout += text; } }, stderr: { write: text => { result.stderr += text; } } };
}
async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'pc-'));
  const calls = [], verified = [];
  const channel = createAgentChannel({ stateDir, verifyAgent: async () => false, onMessage: async () => { throw Error(); },
    verifyPeer: async (id, value) => { verified.push([id, value]); return id === A && value.requestId === 'request-one' ? { ...actor, secret: 'must-not-forward' } : false; },
    onPeerCall: async (request, caller) => { calls.push({ request, caller }); return { content: [{ type: 'text', text: 'ok' }] }; }, ...overrides });
  t.after(async () => { await channel.close(); await rm(stateDir, { recursive: true, force: true }); });
  await channel.issue(A);
  return { stateDir, channel, calls, verified, socketPath: join(stateDir, 'agent-channel.sock'), key: await readAgentCapability(stateDir, A) };
}
function post(f, value = body(), key = f.key) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: f.socketPath, method: 'POST', path: '/peer-mcp', headers: { authorization: `Bearer ${key}` } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; }); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
    });
    request.once('error', reject); request.end(typeof value === 'string' ? value : JSON.stringify(value));
  });
}
function cliOptions(f, output, extra = {}) { return { stateDir: f.stateDir, env: { PASEO_AGENT_ID: A }, stdin: Readable.from(['{}']), ...output, ...extra }; }

test('peer MCP real Unix call forwards only verified actor and separates old authentication', async t => {
  const f = await fixture(t); await f.channel.listen();
  assert.deepEqual(await post(f), { status: 200, body: { jsonrpc: '2.0', id: 'request-one', result: { content: [{ type: 'text', text: 'ok' }] } } });
  assert.deepEqual(f.calls[0].caller, actor);
  assert.deepEqual(f.verified[0], [A, { requestId: 'request-one', rpc: rpc() }]);
  assert.equal(JSON.stringify(f.calls).includes('must-not-forward'), false);
  assert.match(f.channel.peerCommand, /peer-agent\.mjs/);
  assert.equal(f.channel.peerCommand.includes(f.key), false);
  assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
  await f.channel.close(); await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' });
});

test('only verifier supplies optional positive safe generation for native identity', async t => {
  let generation = 1;
  const f = await fixture(t, { verifyPeer: async () => ({ ...actor, generation, secret: 'must-not-forward' }) });
  await f.channel.listen();
  for (const valid of [1, Number.MAX_SAFE_INTEGER, undefined]) {
    generation = valid;
    const result = await post(f);
    assert.equal(result.status, 200);
    assert.deepEqual(f.calls.at(-1).caller, { ...actor, ...(valid !== undefined ? { generation: valid } : {}) });
    assert.equal(JSON.stringify(result.body).includes('generation'), false);
  }
  const count = f.calls.length;
  for (const invalid of [0, -1, 1.5, '1', null, true, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    generation = invalid;
    assert.equal((await post(f)).status, 403);
  }
  assert.equal(f.calls.length, count);
  generation = 2;
  for (const forged of [body({ generation: 99 }), body({ owner: 'forged-owner' }),
    body({ rpc: { ...rpc(), generation: 99 } }), body({ rpc: { ...rpc(), params: { name: 'list_peers', generation: 99 } } })]) {
    assert.equal((await post(f, forged)).status, 400);
  }
  assert.equal(f.calls.length, count);
  assert.equal((await post(f)).status, 200);
  assert.deepEqual(f.calls.at(-1).caller, { ...actor, generation: 2 });
});

test('bad capability, forged native ID, stale dispatch and disabled peer branch fail closed', async t => {
  const f = await fixture(t); await f.channel.issue(B); await f.channel.listen();
  assert.equal((await post(f, body(), 'f'.repeat(64))).status, 403);
  assert.equal((await post(f, body({ agentId: B }))).status, 403);
  assert.equal(f.verified.length, 0);
  assert.equal((await post(f, body({ requestId: 'old-request' }))).status, 403);
  assert.equal(f.calls.length, 0);
  const disabled = await fixture(t, { verifyPeer: undefined }); await disabled.channel.listen();
  assert.equal((await post(disabled)).status, 403);
  const forged = await fixture(t, { verifyPeer: async () => ({ ...actor, agentId: B }) }); await forged.channel.listen();
  assert.equal((await post(forged)).status, 403);
});

test('strict peer schema rejects arbitrary tools, caller fields, notifications and malformed RPC', async t => {
  const f = await fixture(t); await f.channel.listen();
  const invalid = [ '{', body({ owner: 'other' }), body({ rpc: rpc('run_command') }),
    body({ rpc: { ...rpc(), id: null } }), body({ rpc: { ...rpc(), id: {} } }), body({ rpc: { ...rpc(), id: -1 } }),
    body({ rpc: { ...rpc(), jsonrpc: '1.0' } }), body({ rpc: { ...rpc(), method: 'initialize' } }),
    body({ rpc: { ...rpc(), _meta: { owner: 'other' } } }), body({ rpc: { ...rpc(), params: { name: 'list_peers', arguments: [] } } }),
    body({ rpc: { ...rpc(), params: { name: 'list_peers', owner: 'other' } } }), body({ requestId: '../escape' }),
  ];
  for (const value of invalid) assert.equal((await post(f, value)).status, 400);
  assert.equal(f.calls.length, 0);
  assert.doesNotThrow(() => validatePeerRequest(body({ rpc: { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} } })));
  assert.throws(() => validatePeerRequest(body({ rpc: { jsonrpc: '2.0', id: 0, method: 'tools/list', params: { cursor: 5 } } })));
});

test('unregistered actor may list/register but cannot read/send/ack', async t => {
  const f = await fixture(t, { verifyPeer: async () => ({ owner: actor.owner, hostId: actor.hostId, agentId: A }) }); await f.channel.listen();
  for (const name of ['list_peers', 'register_peer']) assert.equal((await post(f, body({ rpc: rpc(name, { kind: 'local' }) }))).status, 200);
  for (const name of ['send_peer_message', 'get_peer_message', 'list_peer_messages', 'ack_peer_message', 'unregister_peer']) {
    assert.equal((await post(f, body({ rpc: rpc(name) }))).status, 403);
  }
  assert.equal(f.calls.length, 2);
});

test('oversized HTTP body is rejected before verification or persistence', async t => {
  const f = await fixture(t); await f.channel.listen();
  const result = await post(f, body({ rpc: rpc('send_peer_message', { text: 'x'.repeat(65536) }) }));
  assert.equal(result.status, 413); assert.equal(f.verified.length, 0); assert.equal(f.calls.length, 0);
});

test('callback exceptions and invalid results are safe JSON-RPC unknown outcomes', async t => {
  for (const onPeerCall of [async () => { throw Error('credential and private-body'); }, async () => undefined]) {
    const f = await fixture(t, { onPeerCall }); await f.channel.listen();
    const result = await post(f);
    assert.deepEqual(result, { status: 500, body: { jsonrpc: '2.0', id: 'request-one', error: { code: -32603, message: 'peer_call_outcome_unknown' }, safe_code: 'peer_call_outcome_unknown', retrySafe: false } });
    assert.equal(JSON.stringify(result).includes('private-body'), false);
  }
});

test('CLI roundtrip uses only fixed env identity and JSON stdin arguments', async t => {
  const f = await fixture(t); await f.channel.listen(); const output = outputs();
  const args = { messageId: 'stable-message', fromPeerId: 'native-one', toPeerId: 'chat-one', text: '中文' };
  const bytes = Buffer.from(JSON.stringify(args));
  assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'send_peer_message'], cliOptions(f, output, { stdin: Readable.from([...bytes].map(byte => Buffer.from([byte]))) })), 0);
  assert.equal(output.result.stderr, ''); assert.equal(JSON.parse(output.result.stdout).jsonrpc, '2.0');
  assert.deepEqual(f.calls[0].request.params.arguments, args); assert.equal(f.calls[0].caller.agentId, A);
  assert.equal(output.result.stdout.includes(f.key), false);
  for (const options of [{ env: {} }, { stdin: Readable.from(['[]']) }, { stdin: Readable.from(['{"text":"' + 'x'.repeat(65536) + '"}']) }]) {
    const invalid = outputs();
    assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'list_peers'], cliOptions(f, invalid, options)), 2);
    assert.equal(invalid.result.stdout, ''); assert.equal(JSON.parse(invalid.result.stderr).safe_code, 'invalid_input');
  }
  assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'list_peers', '--agent-id', B], cliOptions(f, outputs())), 2);
});

test('CLI cap permissions and symlinks are refused without exposing request text or token', async t => {
  const f = await fixture(t); const cap = join(f.stateDir, 'agent-channels', `${A}.json`);
  await chmod(cap, 0o644);
  const run = async () => {
    const output = outputs();
    assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'send_peer_message'], cliOptions(f, output, { stdin: Readable.from(['{"text":"private-body"}']) })), 1);
    assert.deepEqual(JSON.parse(output.result.stderr), { status: 'unauthorized', safe_code: 'capability_unavailable', retrySafe: false });
    assert.equal(output.result.stderr.includes('private-body'), false); assert.equal(output.result.stderr.includes(f.key), false);
  };
  await run(); await chmod(cap, 0o600);
  const content = await readFile(cap); await unlink(cap); const outside = join(f.stateDir, 'outside');
  await writeFile(outside, content, { mode: 0o600 }); await symlink(outside, cap); await run();
  assert.deepEqual(await readFile(outside), content);
});

test('CLI default waits for real Unix verification exceeding five seconds', { timeout: 20000 }, async t => {
  const f = await fixture(t, { verifyPeer: async (id, value) => {
    await new Promise(resolve => setTimeout(resolve, 5500));
    return id === A && value.requestId === 'request-one' ? actor : false;
  } });
  await f.channel.listen();
  const output = outputs(), start = Date.now();
  // Leave the client's network timeout at its executable default. The verifier
  // models independent remote identity/workspace reads before tool execution.
  assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'get_peer_message'],
    cliOptions(f, output, { stdin: Readable.from(['{"messageId":"original-message"}']) })), 0);
  assert.ok(Date.now() - start >= 5000);
  assert.equal(output.result.stderr, '');
  assert.deepEqual(JSON.parse(output.result.stdout), { jsonrpc: '2.0', id: 'request-one', result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].request.params.arguments, { messageId: 'original-message' });
});

test('CLI network/input timeouts are bounded with no replay or fresh message ID', async t => {
  let count = 0;
  const f = await fixture(t, { onPeerCall: async () => { count++; return new Promise(() => {}); } }); await f.channel.listen();
  const output = outputs(); const start = Date.now();
  assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'send_peer_message'], cliOptions(f, output, { networkTimeoutMs: 30 })), 1);
  assert.ok(Date.now() - start < 1000); assert.equal(count, 1);
  assert.deepEqual(JSON.parse(output.result.stderr.split('\n')[0]), { status: 'outcome_unknown', safe_code: 'network_timeout', retrySafe: false });
  assert.match(output.result.stderr, /get_peer_message with the original messageId/);
  const input = new PassThrough(); const invalid = outputs();
  assert.equal(await runPeerAgent(['--request-id', 'request-one', '--tool', 'list_peers'], cliOptions(f, invalid, { stdin: input, inputTimeoutMs: 20 })), 2);
  assert.equal(input.destroyed, true); assert.equal(count, 1);
});
