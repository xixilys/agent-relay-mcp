import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, rm, lstat, chmod, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRemoteChannel } from '../src/remote-channel.js';
import { createAgentChannel } from '../src/agent-channel.js';
import { validateSshTarget } from '../src/ssh-bridge.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const caller = { owner: 'synthetic-owner', hostId: 'synthetic-wsl', agentId: A, peerId: 'native-wsl' };
async function execute(file, args, options, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
async function localRemote(script, input) {
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], {}, JSON.stringify(input));
  if (result.code !== 0) throw Error('remote_operation_failed');
  return JSON.parse(result.stdout);
}
async function forward(_target, { localSocket, remoteSocket, onClose }) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const upstream = net.createConnection(localSocket);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.pipe(upstream); upstream.pipe(socket); socket.once('close', () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(remoteSocket, resolve); });
  await chmod(remoteSocket, 0o600); server.once('close', onClose);
  return { close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'prc-'));
  const stateDir = join(root, 'l'), remoteStateDir = join(root, 'r');
  const host = { id: 'synthetic-wsl', target: 'ssh://synthetic-wsl', remoteStateDir, nodeCommand: process.execPath };
  const calls = [], factories = [], channels = [];
  const verifyPeer = async (id, value) => id === A && value.requestId === 'request-one' ? caller : false;
  const onPeerCall = async (request, actor) => { calls.push({ request, actor }); return { content: [{ type: 'text', text: 'synthetic-receipt' }] }; };
  const make = (localState = stateDir) => {
    const channel = createRemoteChannel({ host, target: validateSshTarget(host.target), stateDir: localState,
      runRemote: localRemote, forwardFactory: forward, verifyAgent: async () => false, onMessage: async () => { throw Error(); },
      verifyPeer, onPeerCall, localChannelFactory: options => { factories.push(options); return createAgentChannel(options); } });
    channels.push(channel); return channel;
  };
  const channel = make();
  t.after(async () => { for (const item of channels) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, remoteStateDir, host, calls, factories, channel, make, verifyPeer, onPeerCall };
}

const peerNames = ['bin/peer-agent.mjs', 'peer-agent.mjs'];

test('remote preparation installs complete owned peer helper and forwards callbacks/command', async t => {
  const f = await fixture(t); await f.channel.listen(); await assert.rejects(lstat(f.remoteStateDir), { code: 'ENOENT' });
  await f.channel.issue(A);
  assert.equal(f.factories[0].verifyPeer, f.verifyPeer); assert.equal(f.factories[0].onPeerCall, f.onPeerCall);
  assert.match(f.channel.peerCommand, /peer-agent\.mjs/);
  const cap = await readFile(join(f.remoteStateDir, 'agent-channels', `${A}.json`), 'utf8');
  assert.equal(cap, await readFile(join(f.stateDir, 'agent-channels', `${A}.json`), 'utf8'));
  assert.equal(f.channel.peerCommand.includes(JSON.parse(cap).key), false);
  const marker = JSON.parse(await readFile(join(f.remoteStateDir, '.bridge-owner.json'), 'utf8'));
  assert.deepEqual(Object.keys(marker.files).sort(), ['package.json', 'src/agent-channel.js', 'bin/dot-message.mjs', 'dot-message.mjs', ...peerNames].sort());
  for (const name of peerNames) assert.equal((await lstat(join(f.remoteStateDir, name))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(f.remoteStateDir, 'bin/peer-agent.mjs'), 'utf8'), await readFile(new URL('../bin/peer-agent.mjs', import.meta.url), 'utf8'));
  const result = await execute('/bin/sh', ['-c', `${f.channel.peerCommand} --request-id request-one --tool send_peer_message`],
    { env: { ...process.env, PASEO_AGENT_ID: A } }, JSON.stringify({ messageId: 'fixed-original-id', fromPeerId: 'native-wsl', toPeerId: 'chat', text: 'synthetic-message' }));
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { jsonrpc: '2.0', id: 'request-one', result: { content: [{ type: 'text', text: 'synthetic-receipt' }] } });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].actor, caller); assert.equal(f.calls[0].request.params.arguments.messageId, 'fixed-original-id');
  await f.channel.close();
  await assert.rejects(lstat(join(f.remoteStateDir, 'agent-channel.sock')), { code: 'ENOENT' });
});

test('actual Direct worker can initialize first and peer install preserves its marker and data', async t => {
  const f = await fixture(t);
  const result = await execute(process.execPath, [fileURLToPath(new URL('../src/direct-command-worker.mjs', import.meta.url))], {},
    `${JSON.stringify({ id: 'synthetic-init', op: 'init', config: { hostId: f.host.id, remoteStateDir: f.remoteStateDir, projects: [], allowedRoots: [] } })}\n`);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { replyTo: 'synthetic-init', ok: true, result: { ready: true } });
  const directMarker = join(f.remoteStateDir, 'direct/.direct-owner.json');
  const before = await readFile(directMarker, 'utf8'), info = await lstat(directMarker);
  assert.deepEqual(JSON.parse(before), { hostId: f.host.id, uid: process.getuid() });
  const data = join(f.remoteStateDir, 'direct/existing-receipt.json');
  await writeFile(data, 'preserve-direct-receipt', { mode: 0o600 });
  await f.channel.issue(A);
  assert.equal(await readFile(directMarker, 'utf8'), before); assert.equal((await lstat(directMarker)).ino, info.ino);
  assert.equal(await readFile(data, 'utf8'), 'preserve-direct-receipt');
  assert.equal((await lstat(join(f.remoteStateDir, '.bridge-owner.json'))).mode & 0o777, 0o600);
  const call = await execute('/bin/sh', ['-c', `${f.channel.peerCommand} --request-id request-one --tool list_peers`],
    { env: { ...process.env, PASEO_AGENT_ID: A } }, '{}');
  assert.equal(call.code, 0); assert.equal(f.calls.length, 1);
});

test('an existing empty private gateway root can initialize its owned peer marker', async t => {
  const f = await fixture(t); await mkdir(f.remoteStateDir, { mode: 0o700 });
  await f.channel.prepare();
  const marker = JSON.parse(await readFile(join(f.remoteStateDir, '.bridge-owner.json'), 'utf8'));
  assert.equal(marker.version, 1); assert.ok(marker.files['peer-agent.mjs']);
});

test('Direct-first adoption rejects wrong host/uid, extra marker fields and unsafe paths without writing', async t => {
  for (const kind of ['host', 'uid', 'extra', 'directory-mode', 'marker-mode', 'marker-link', 'userdata']) {
    const f = await fixture(t); const direct = join(f.remoteStateDir, 'direct');
    await mkdir(direct, { mode: 0o700, recursive: true });
    const marker = join(direct, '.direct-owner.json');
    const value = { hostId: kind === 'host' ? 'another-host' : f.host.id, uid: process.getuid() + (kind === 'uid' ? 1 : 0),
      ...(kind === 'extra' ? { extra: true } : {}) };
    const text = JSON.stringify(value); await writeFile(marker, text, { mode: 0o600 });
    if (kind === 'directory-mode') await chmod(direct, 0o755);
    if (kind === 'marker-mode') await chmod(marker, 0o644);
    if (kind === 'marker-link') {
      const outside = join(f.root, 'marker-target'); await writeFile(outside, text, { mode: 0o600 });
      await unlink(marker); await symlink(outside, marker);
    }
    const userData = join(f.remoteStateDir, 'user-data');
    if (kind === 'userdata') await writeFile(userData, 'untouched-user-data', { mode: 0o600 });
    await assert.rejects(f.channel.prepare(), /remote_operation_failed/, kind);
    await assert.rejects(lstat(join(f.remoteStateDir, '.bridge-owner.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.remoteStateDir, 'peer-agent.mjs')), { code: 'ENOENT' });
    assert.equal(await readFile(marker, 'utf8'), text);
    if (kind === 'userdata') assert.equal(await readFile(userData, 'utf8'), 'untouched-user-data');
  }
});

test('legacy four-file owned marker is upgraded in place without changing capability', async t => {
  const f = await fixture(t); await f.channel.issue(A); await f.channel.close();
  const path = join(f.remoteStateDir, '.bridge-owner.json');
  const marker = JSON.parse(await readFile(path, 'utf8'));
  for (const name of peerNames) { delete marker.files[name]; await unlink(join(f.remoteStateDir, name)); }
  await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
  const capPath = join(f.remoteStateDir, 'agent-channels', `${A}.json`), before = await readFile(capPath, 'utf8');
  const next = f.make(f.stateDir); await next.issue(A);
  assert.equal(await readFile(capPath, 'utf8'), before);
  const after = JSON.parse(await readFile(path, 'utf8'));
  for (const name of peerNames) { assert.equal(typeof after.files[name], 'string'); assert.ok((await readFile(join(f.remoteStateDir, name), 'utf8')).length > 0); }
});

test('unowned peer wrapper or capability symlink remains protected on reinstall', async t => {
  const f = await fixture(t); await f.channel.issue(A); await f.channel.close();
  const helper = join(f.remoteStateDir, 'peer-agent.mjs');
  await writeFile(helper, 'unrelated-owner-edited', { mode: 0o600 });
  await assert.rejects(f.make(f.stateDir).prepare(), /remote_operation_failed/);
  assert.equal(await readFile(helper, 'utf8'), 'unrelated-owner-edited');
  const g = await fixture(t); await g.channel.issue(A);
  const cap = join(g.remoteStateDir, 'agent-channels', `${A}.json`), outside = join(g.root, 'outside');
  await writeFile(outside, 'untouched', { mode: 0o600 }); await unlink(cap); await symlink(outside, cap);
  const result = await execute('/bin/sh', ['-c', `${g.channel.peerCommand} --request-id request-one --tool list_peers`],
    { env: { ...process.env, PASEO_AGENT_ID: A } }, '{}');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).safe_code, 'capability_unavailable');
  assert.equal(await readFile(outside, 'utf8'), 'untouched'); assert.equal(g.calls.length, 0);
});

test('remote close preserves a replaced public socket', async t => {
  const f = await fixture(t); await f.channel.prepare();
  const path = join(f.remoteStateDir, 'agent-channel.sock'); await unlink(path);
  await writeFile(path, 'unrelated-replacement', { mode: 0o600 });
  await f.channel.close(); assert.equal(await readFile(path, 'utf8'), 'unrelated-replacement');
});
