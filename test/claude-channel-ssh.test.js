import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, chmod, rm, readFile, writeFile, unlink, readdir, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { PeerService } from '../src/peer-service.js';
import { createClaudeChannel } from '../src/claude-channel.js';
import { runClaudeChannelSSH, validateSSHOptions } from '../bin/claude-channel-ssh.mjs';

const launcher = fileURLToPath(new URL('../bin/claude-channel-ssh.mjs',import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(check,timeout = 14000) {
  const deadline = Date.now()+timeout;
  while (!(await check())) { if (Date.now()>deadline) throw Error('test_wait_timeout'); await sleep(20); }
}
function alive(pid) { try { process.kill(pid,0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
const notificationSchema = z.object({ method: z.literal('notifications/claude/channel'),params: z.object({ content: z.string(),meta: z.record(z.string(),z.string()) }) });

// This child replaces only the SSH link, forwarding Unix sockets and allowing
// controlled loss after a gateway has persisted a write. It speaks no MCP.
const fakeSSH = `#!${process.execPath}
const net = require('node:net'), fs = require('node:fs');
const args = process.argv.slice(2), spec = args[args.indexOf('-L')+1];
const [local,remote] = spec.split(':');
fs.appendFileSync(process.env.CC_RECORD,JSON.stringify({pid:process.pid,args,local})+'\\n');
if (process.env.CC_FATAL) { process.stderr.write(process.env.CC_FATAL+' /secret/source/path SECRET_KEY peer_private_text\\n'); setTimeout(()=>process.exit(255),100); }
else {
  process.stderr.write('fixture private path /secret/source/path SECRET_KEY peer_private_text\\n');
  const sockets = new Set();
  const server = net.createServer(front => {
    const back = net.createConnection(remote); sockets.add(front); sockets.add(back);
    let request = '',send = false;
    front.on('data',chunk => {
      request += chunk;
      send ||= request.includes('POST /tool') && request.includes('send_peer_message');
      back.write(chunk);
    });
    back.on('data',chunk => {
      if (send && fs.existsSync(process.env.CC_DROP)) { fs.unlinkSync(process.env.CC_DROP); process.exit(23); }
      front.write(chunk);
    });
    front.on('end',()=>back.end()); back.on('end',()=>front.end());
    for (const [a,b] of [[front,back],[back,front]]) {
      a.on('error',()=>{a.destroy();b.destroy();});
      a.on('close',()=>{sockets.delete(a);b.destroy();});
    }
  });
  server.on('error',()=>process.exit(24));
  const open = () => {
    if (fs.existsSync(process.env.CC_HOLD)) { setTimeout(open,50); return; }
    server.listen(local,()=>fs.chmodSync(local,0o600));
  }; open();
  process.on('SIGTERM',()=>{ for (const s of sockets) s.destroy(); server.close(()=>process.exit(0)); if (!server.listening) process.exit(0); });
}
`;

async function fixture(t,{ fatal,hold = false } = {}) {
  const dir = await mkdtemp(join(realpathSync(tmpdir()),'ccs-'));
  const stateDir = join(dir,'s'),gatewayDir = join(dir,'g'),sshDir = join(dir,'b');
  for (const path of [stateDir,gatewayDir,sshDir]) await mkdir(path,{ mode: 0o700 });
  await writeFile(join(sshDir,'ssh'),fakeSSH,{ mode: 0o700 });
  const record = join(dir,'record'),drop = join(dir,'drop'),holdPath = join(dir,'hold');
  if (hold) await writeFile(holdPath,'hold');
  const env = { PATH: `${sshDir}:${process.env.PATH}`,CC_RECORD: record,CC_DROP: drop,CC_HOLD: holdPath,...(fatal ? { CC_FATAL: fatal } : {}) };
  const peers = new PeerService({ stateDir: gatewayDir });
  const call = (name,args) => peers.call(name,args,{ owner: 'owner' });
  for (const peerId of ['pro','claude']) await call('register_peer',{ peerId,kind: 'chat' });
  let gateway;
  const listen = async () => { gateway = createClaudeChannel({ stateDir: gatewayDir,binding: { owner: 'owner',peerId: 'claude',generation: 1 },peers }); await gateway.listen(); };
  await listen();
  const args = [launcher,'--ssh-alias','mac','--remote-socket',gateway.socketPath,'--state-dir',stateDir];
  const attempts = async () => { try { return (await readFile(record,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const owned = [];
  t.after(async () => {
    for (const resource of owned) await resource.close();
    for (const { pid } of await attempts()) if (alive(pid)) { process.kill(pid,'SIGKILL'); await until(() => !alive(pid)); }
    await gateway.close(); await peers.close(); await rm(dir,{ recursive: true,force: true });
  });
  async function connect() {
    const transport = new StdioClientTransport({ command: process.execPath,args,env,stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data',chunk => { stderr+=chunk; });
    const client = new Client({ name: 'ssh-lifecycle-test',version: '1' },{ capabilities: {} });
    const notifications = [];
    client.setNotificationHandler(notificationSchema,n => { notifications.push(n); });
    owned.push(client); await client.connect(transport);
    return { client,transport,notifications,stderr: () => stderr };
  }
  async function raw() {
    const processChild = spawn(process.execPath,args,{ env: { ...process.env,...env },stdio: ['pipe','pipe','pipe'] });
    let stderr = '',stdout = '';
    processChild.stderr.on('data',chunk => { stderr+=chunk; }); processChild.stdout.on('data',chunk => { stdout+=chunk; });
    const closed = new Promise(resolve => processChild.once('close',code => resolve(code)));
    owned.push({ close: async () => { if (processChild.exitCode === null) { processChild.stdin.end(); await Promise.race([closed,sleep(2000)]); if (processChild.exitCode === null) processChild.kill('SIGTERM'); await closed; } } });
    return { processChild,closed,stderr: () => stderr,stdout: () => stdout };
  }
  return { dir,stateDir,peers,call,listen,closeGateway: () => gateway.close(),args,env,attempts,connect,raw,drop,holdPath,
    send: () => call('send_peer_message',{ messageId: randomUUID(),fromPeerId: 'pro',toPeerId: 'claude',text: 'private exact peer text' }) };
}

test('same initialized MCP session survives owned SSH loss and gateway SSE restart without duplicate writes',async t => {
  const f = await fixture(t);
  const { client,transport,notifications,stderr } = await f.connect();
  const pid = transport.pid;
  assert.equal((await client.listTools()).tools.length,4);
  const original = await f.send(); await until(() => notifications.length === 1);
  assert.equal(JSON.parse((await client.callTool({ name: 'get_peer_message',arguments: { messageId: original.messageId } })).content[0].text).text,'private exact peer text');
  const first = (await f.attempts())[0];
  assert.deepEqual(first.args.slice(0,3),['-NT','-S','none']);
  assert.deepEqual(first.args.slice(-3),['-L',`${first.local}:${join(f.dir,'g','claude-channel.sock')}`,'mac']);
  assert.ok(first.args.includes('BatchMode=yes')); assert.ok(first.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!first.args.some(arg => /StrictHostKeyChecking=(?:no|accept-new)/.test(arg)));
  assert.ok(first.args.includes('ServerAliveInterval=15')); assert.ok(first.args.includes('ServerAliveCountMax=3'));
  assert.equal((await lstat(first.local)).mode & 0o077,0);
  process.kill(first.pid,'SIGKILL');
  await until(async () => (await f.attempts()).length === 2);
  await client.listTools(); assert.equal(transport.pid,pid); assert.ok(alive(pid));
  await until(() => stderr().split('event_stream_connected').length >= 3);
  assert.equal(notifications.length,1); // Original backlog replay is deduplicated.
  await f.closeGateway(); await f.listen();
  await until(() => stderr().split('event_stream_connected').length >= 4);
  assert.equal((await f.attempts()).length,2); assert.equal(transport.pid,pid);
  assert.equal(notifications.length,1);
  const replyId = randomUUID();
  const replyArgs = { messageId: replyId,fromPeerId: 'claude',toPeerId: 'pro',inReplyTo: original.messageId,text: 'stable reply' };
  await writeFile(f.drop,'drop persisted tool response');
  const uncertain = await client.callTool({ name: 'send_peer_message',arguments: replyArgs });
  assert.equal(uncertain.isError,true); assert.match(uncertain.content[0].text,/uncertain writes require recovery/);
  assert.ok(f.peers.store.getMessage('owner',replyId));
  await until(async () => (await f.attempts()).length === 3);
  await until(() => stderr().split('event_stream_connected').length >= 5);
  const outbox = JSON.parse((await client.callTool({ name: 'list_peer_messages',arguments: { peerId: 'claude',direction: 'outbox',includeProcessed: true } })).content[0].text);
  assert.deepEqual(outbox.messages.map(m => m.messageId),[replyId]);
  assert.equal(f.peers.store.db.prepare('SELECT COUNT(*) AS n FROM peer_messages WHERE from_peer_id=?').get('claude').n,1);
  const explicitRecovery = await client.callTool({ name: 'send_peer_message',arguments: replyArgs });
  assert.equal(JSON.parse(explicitRecovery.content[0].text).duplicate,true);
  await client.callTool({ name: 'ack_peer_message',arguments: { messageId: original.messageId,peerId: 'claude' } });
  assert.notEqual(f.peers.store.getMessage('owner',original.messageId).processedAt,null);
  const next = await f.send(); await until(() => notifications.length === 2);
  assert.equal(notifications[1].params.meta.message_id,next.messageId);
  await client.close(); await until(() => !alive(pid));
  assert.ok((await f.attempts()).every(({ pid }) => !alive(pid)));
  assert.deepEqual(await readdir(f.stateDir),[]);
  assert.ok(!stderr().includes('SECRET_KEY')); assert.ok(!stderr().includes('/secret/source/path')); assert.ok(!stderr().includes('private exact peer text'));
});

test('initial missing forward preserves initialized stdio while tools/list times out and later recovers',async t => {
  const f = await fixture(t,{ hold: true });
  const start = Date.now(); const { client,transport } = await f.connect(); const pid = transport.pid;
  assert.ok(Date.now()-start<3000);
  await assert.rejects(client.listTools(),/channel_not_connected/);
  assert.equal(transport.pid,pid); assert.ok(alive(pid));
  await unlink(f.holdPath);
  assert.equal((await client.listTools()).tools.length,4);
  assert.equal(transport.pid,pid);
  await client.close(); await until(() => !alive(pid));
  assert.ok((await f.attempts()).every(({ pid }) => !alive(pid)));
});

for (const [label,error,reason] of [
  ['changed host key','WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!','ssh_host_key_failed'],
  ['missing known host key','No ED25519 host key is known and you have requested strict checking.\nHost key verification failed.','ssh_host_key_failed'],
  ['authentication failure','Permission denied (publickey).','ssh_auth_failed'],
]) test(`${label} stops the launcher and never retries or leaks SSH output`,async t => {
  const f = await fixture(t,{ fatal: error }); const run = await f.raw();
  assert.equal(await run.closed,1);
  const attempts = await f.attempts(); assert.equal(attempts.length,1);
  assert.ok(attempts.every(({ pid }) => !alive(pid)));
  assert.match(run.stderr(),new RegExp(reason));
  assert.equal(run.stdout(),''); assert.ok(!run.stderr().includes('SECRET_KEY')); assert.ok(!run.stderr().includes('/secret/source/path'));
  assert.deepEqual(await readdir(f.stateDir),[]);
});

for (const signal of ['SIGTERM','SIGINT','EOF']) test(`${signal} tears down only the owned SSH child and temporary directory`,async t => {
  const f = await fixture(t); const run = await f.raw();
  await until(async () => (await f.attempts()).length === 1);
  await sleep(100);
  if (signal === 'EOF') run.processChild.stdin.end(); else run.processChild.kill(signal);
  assert.equal(await run.closed,0);
  assert.ok((await f.attempts()).every(({ pid }) => !alive(pid)));
  assert.deepEqual(await readdir(f.stateDir),[]);
});

test('unsafe state directories and ambiguous SSH forwarding syntax are rejected before spawn',async t => {
  const dir = await mkdtemp(join(realpathSync(tmpdir()),'ccv-')); t.after(() => rm(dir,{ recursive: true,force: true }));
  const options = { sshAlias: 'mac',remoteSocketPath: '/private/channel.sock',stateDir: dir };
  for (const extra of [{ sshAlias: '-oProxyCommand=bad' },{ remoteSocketPath: '/tmp/bad:socket' },{ remoteSocketPath: '/tmp/../channel' },{ stateDir: '/tmp/bad\npath' }]) assert.throws(() => validateSSHOptions({ ...options,...extra }),/invalid_options/);
  await chmod(dir,0o755);
  await assert.rejects(runClaudeChannelSSH({ ...options,spawnSSH: () => { throw Error('must not spawn'); } }),/unsafe_local_path/);
  await chmod(dir,0o700);
  const link = join(dir,'link'); await symlink(dir,link);
  await assert.rejects(runClaudeChannelSSH({ ...options,stateDir: link,spawnSSH: () => { throw Error('must not spawn'); } }),/unsafe_local_path/);
  assert.deepEqual(await readdir(dir),['link']);
});

test('unsafe socket replacement stops the launcher and preserves the unowned replacement',async t => {
  const f = await fixture(t); const { client,transport,stderr } = await f.connect();
  await client.listTools(); const pid = transport.pid;
  const [{ local }] = await f.attempts();
  await unlink(local); await writeFile(local,'preserve unexpected replacement',{ mode: 0o600 });
  await until(() => !alive(pid));
  assert.match(stderr(),/unsafe_local_path/);
  assert.ok((await f.attempts()).every(({ pid }) => !alive(pid)));
  assert.equal(await readFile(local,'utf8'),'preserve unexpected replacement');
  assert.equal((await readdir(f.stateDir)).length,1);
});

test('immediate stdin EOF after socket replacement preserves the file before the safety monitor can run',async t => {
  const f = await fixture(t); const run = await f.raw();
  let local;
  await until(async () => {
    const [attempt] = await f.attempts(); local = attempt?.local;
    return local && await lstat(local).then(info => info.isSocket(),() => false);
  });
  // The raw process never initializes MCP: no SSE check can mask the
  // requested EOF shutdown race before the periodic 500ms path monitor.
  await unlink(local); await writeFile(local,'preserve EOF replacement',{ mode: 0o600 });
  run.processChild.stdin.end();
  assert.equal(await run.closed,1);
  assert.match(run.stderr(),/stdin_eof/); assert.match(run.stderr(),/unsafe_local_path/);
  assert.ok((await f.attempts()).every(({ pid }) => !alive(pid)));
  assert.equal(await readFile(local,'utf8'),'preserve EOF replacement');
});

test('shutdown finishes when the injected child closes during asynchronous ownership validation',async t => {
  const stateDir = await mkdtemp(join(realpathSync(tmpdir()),'ccr-'));
  t.after(() => rm(stateDir,{ recursive: true,force: true }));
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.signalCode = null;
  let armed = false,exited = false,killCalls = 0,closedDuringCheck = false;
  Object.defineProperty(child,'exitCode',{ get() {
    if (armed && !exited) {
      // close() first inspects exitCode synchronously, then checkLocal()
      // yields to lstat. Emit close in that precise intervening turn.
      armed = false;
      queueMicrotask(() => { exited = true; closedDuringCheck = true; child.emit('close',0); });
      return null;
    }
    return exited ? 0 : null;
  } });
  child.kill = () => { killCalls++; return false; };
  const runtime = await runClaudeChannelSSH({ sshAlias: 'mac',remoteSocketPath: '/private/channel.sock',stateDir,
    input: new PassThrough(),output: new PassThrough(),spawnSSH: () => child });
  armed = true;
  let timer;
  try {
    await Promise.race([runtime.close(),new Promise((_,reject) => { timer = setTimeout(() => reject(Error('shutdown_missed_child_close')),1000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(closedDuringCheck,true); assert.equal(killCalls,0);
  assert.equal((await runtime.closed).reason,'requested_close');
  assert.deepEqual(await readdir(stateDir),[]);
});

for (const status of [403,409]) test(`gateway ${status} stops the owned tunnel without evicting an existing consumer`,async t => {
  const f = await fixture(t);
  let first;
  if (status === 403) await f.call('unregister_peer',{ peerId: 'claude' });
  else { first = await f.connect(); await first.client.listTools(); }
  const second = await f.connect(); const pid = second.transport.pid;
  await until(() => !alive(pid));
  assert.match(second.stderr(),new RegExp(status === 403 ? 'binding_inactive' : 'consumer_conflict'));
  if (first) { assert.ok(alive(first.transport.pid)); assert.equal((await first.client.listTools()).tools.length,4); }
  await until(async () => (await f.attempts()).filter(({ pid }) => alive(pid)).length === (first ? 1 : 0));
});
