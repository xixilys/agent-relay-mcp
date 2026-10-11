import http from 'node:http';
import net from 'node:net';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, link, unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const DEFAULT_AGENT_STATE_DIR = join(homedir(), '.local', 'share', 'local-agents-mcp');
export const AGENT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_MESSAGE_LENGTH = 8192;
export const MAX_PEER_BODY_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MAX_PEER_BODY_BYTES;
export const PEER_TOOL_NAMES = Object.freeze([
  'register_peer', 'list_peers', 'unregister_peer', 'send_peer_message',
  'get_peer_message', 'list_peer_messages', 'ack_peer_message',
]);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const uid = () => process.getuid();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function failure(code) { return Object.assign(new Error(code), { code }); }
function agentFile(stateDir, agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) throw failure('invalid_agent_id');
  return join(stateDir, 'agent-channels', `${agentId}.json`);
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid()) throw failure('unsafe_channel_directory');
  await chmod(path, 0o700);
}

// Reject links and publicly readable capability files, including on restart.
export async function readAgentCapability(stateDir, agentId) {
  for (const path of [stateDir, join(stateDir, 'agent-channels')]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o077)) throw failure('unsafe_channel_directory');
  }
  const handle = await open(agentFile(stateDir, agentId), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid() || (info.mode & 0o077) || info.size > 1024) throw failure('unsafe_capability_file');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (value.version !== 1 || value.agentId !== agentId || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) throw failure('invalid_capability_file');
    return value.key;
  } finally { await handle.close(); }
}

export function validateAgentMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'agentId,kind,messageId,requestId,text' ||
      typeof value.agentId !== 'string' || !AGENT_ID_PATTERN.test(value.agentId) ||
      typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId) ||
      typeof value.messageId !== 'string' || !AGENT_ID_PATTERN.test(value.messageId) ||
      !['message', 'needs_input'].includes(value.kind) ||
      typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_MESSAGE_LENGTH) throw failure('invalid_message');
  return value;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const rpcId = value => typeof value === 'string' ? REQUEST_ID_PATTERN.test(value) : Number.isSafeInteger(value) && value >= 0;

// This scoped private bridge supports only request/response peer tools. It does
// not provide MCP sessions, notifications, events, or a general tool transport.
export function validatePeerRequest(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'agentId,requestId,rpc' ||
      typeof value.agentId !== 'string' || !AGENT_ID_PATTERN.test(value.agentId) ||
      typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) throw failure('invalid_peer_request');
  const rpc = value.rpc;
  if (!exactKeys(rpc, ['jsonrpc', 'id', 'method', 'params']) || rpc.jsonrpc !== '2.0' || !rpcId(rpc.id)) throw failure('invalid_peer_request');
  if (rpc.method === 'tools/list') {
    if (rpc.params !== undefined && (!exactKeys(rpc.params, ['cursor']) ||
        (rpc.params.cursor !== undefined && (typeof rpc.params.cursor !== 'string' || rpc.params.cursor.length > 1024)))) throw failure('invalid_peer_request');
  } else if (rpc.method === 'tools/call') {
    if (!exactKeys(rpc.params, ['name', 'arguments']) || !PEER_TOOL_NAMES.includes(rpc.params.name) ||
        (rpc.params.arguments !== undefined && !object(rpc.params.arguments))) throw failure('invalid_peer_request');
  } else throw failure('invalid_peer_request');
  return value;
}

async function socketInUse(path) {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection({ path });
    probe.setTimeout(300);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('timeout', () => { probe.destroy(); reject(failure('socket_probe_timeout')); });
    probe.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

export function createAgentChannel({ stateDir, onMessage, verifyAgent, verifyPeer, onPeerCall,
  cliPath = fileURLToPath(new URL('../bin/dot-message.mjs', import.meta.url)),
  peerCliPath = fileURLToPath(new URL('../bin/peer-agent.mjs', import.meta.url)) }) {
  if (!isAbsolute(stateDir) || typeof onMessage !== 'function' || typeof verifyAgent !== 'function' ||
      (verifyPeer !== undefined && typeof verifyPeer !== 'function') ||
      (onPeerCall !== undefined && typeof onPeerCall !== 'function') || !isAbsolute(peerCliPath)) throw failure('invalid_channel_options');
  const peerCommand = `${quote(process.execPath)} ${quote(peerCliPath)}`;
  const socketPath = join(stateDir, 'agent-channel.sock');
  // Node removes its bind pathname on close without checking its inode. Bind
  // privately and publish a hard link so cleanup cannot remove a replaced entry.
  const bindPath = join(stateDir, `.ac-${randomBytes(6).toString('hex')}.sock`);
  const issues = new Map();
  let socketIdentity;
  let started = false;
  let listenPromise;
  let closePromise;
  const connections = new Set();
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
    const isPeer = request.url === '/peer-mcp';
    if (request.method !== 'POST' || (!isPeer && request.url !== '/message')) { reply(404, { error: 'not_found' }); request.resume(); return; }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reply(413, { error: 'message_too_large' }); request.destroy(); return; }
        chunks.push(chunk);
      }
      let value;
      try { value = (isPeer ? validatePeerRequest : validateAgentMessage)(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reply(400, { error: isPeer ? 'invalid_peer_request' : 'invalid_message' }); return; }
      let key;
      try { key = await readAgentCapability(stateDir, value.agentId); }
      catch { reply(403, { error: 'unauthorized' }); return; }
      const supplied = typeof request.headers.authorization === 'string' ? request.headers.authorization.match(/^Bearer ([a-f0-9]{64})$/)?.[1] : undefined;
      // Both buffers have fixed size; never compare attacker-controlled lengths.
      const tokenMatches = timingSafeEqual(Buffer.from(key, 'hex'), supplied ? Buffer.from(supplied, 'hex') : Buffer.alloc(32));
      if (!supplied || !tokenMatches) { reply(403, { error: 'unauthorized' }); return; }
      if (isPeer) {
        if (!verifyPeer || !onPeerCall) { reply(403, { error: 'request_not_authorized' }); return; }
        let actor;
        try { actor = await verifyPeer(value.agentId, { requestId: value.requestId, rpc: value.rpc }); } catch { actor = false; }
        if (!object(actor) || actor.agentId !== value.agentId ||
            !['owner', 'hostId'].every(key => typeof actor[key] === 'string' && actor[key].length > 0) ||
            (actor.peerId !== undefined && (typeof actor.peerId !== 'string' || actor.peerId.length === 0)) ||
            (actor.generation !== undefined && (!Number.isSafeInteger(actor.generation) || actor.generation <= 0)) ||
            (actor.peerId === undefined && value.rpc.method === 'tools/call' &&
              !['register_peer', 'list_peers'].includes(value.rpc.params.name))) {
          reply(403, { error: 'request_not_authorized' }); return;
        }
        // Identity comes only from the verifier. Do not pass additional verifier
        // fields (including accidental credentials) to the tool implementation.
        const trustedActor = { owner: actor.owner, hostId: actor.hostId, agentId: actor.agentId,
          ...(actor.peerId !== undefined ? { peerId: actor.peerId } : {}),
          ...(actor.generation !== undefined ? { generation: actor.generation } : {}) };
        try {
          const result = await onPeerCall(value.rpc, trustedActor);
          if (!object(result)) throw failure('invalid_peer_result');
          reply(200, { jsonrpc: '2.0', id: value.rpc.id, result });
        } catch {
          // Tool validation belongs in the MCP tool result. Unexpected exceptions
          // may happen after persistence: do not disclose text or retry the write.
          reply(500, { jsonrpc: '2.0', id: value.rpc.id, error: { code: -32603, message: 'peer_call_outcome_unknown' },
            safe_code: 'peer_call_outcome_unknown', retrySafe: false });
        }
        return;
      }
      let verified;
      try { verified = await verifyAgent(value.agentId, value); } catch { verified = false; }
      if (verified !== true) { reply(403, { error: 'request_not_authorized' }); return; }
      const receipt = await onMessage(value);
      if (!receipt || receipt.messageId !== value.messageId || !['accepted', 'duplicate'].includes(receipt.status)) throw failure('invalid_receipt');
      reply(200, { messageId: receipt.messageId, status: receipt.status });
    } catch { reply(500, isPeer ? { error: 'peer_call_outcome_unknown', safe_code: 'peer_call_outcome_unknown', retrySafe: false } : { error: 'acceptance_unknown' }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('error', () => {}); // Listen errors have their own rejecting handler.

  async function issue(agentId) {
    agentFile(stateDir, agentId);
    if (!issues.has(agentId)) issues.set(agentId, (async () => {
      await privateDirectory(stateDir);
      await privateDirectory(join(stateDir, 'agent-channels'));
      try { await readAgentCapability(stateDir, agentId); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const destination = agentFile(stateDir, agentId);
        const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify({ version: 1, agentId, key: randomBytes(32).toString('hex') }));
            await handle.sync();
          } finally { await handle.close(); }
          try { await link(temporary, destination); }
          catch (error) { if (error.code !== 'EEXIST') throw error; await readAgentCapability(stateDir, agentId); }
        } finally { await unlink(temporary).catch(() => {}); }
      }
      return { agentId, stateDir, cliPath };
    })().catch(error => { issues.delete(agentId); throw error; }));
    return issues.get(agentId);
  }

  async function listen() {
    if (closePromise) throw failure('channel_closed');
    if (listenPromise) return listenPromise;
    listenPromise = (async () => {
      await privateDirectory(stateDir);
      await privateDirectory(join(stateDir, 'agent-channels'));
      let previous;
      try { previous = await lstat(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        if (!previous.isSocket() || previous.uid !== uid()) throw failure('unsafe_existing_socket');
        if (await socketInUse(socketPath)) throw failure('channel_already_listening');
        const current = await lstat(socketPath);
        if (!sameFile(previous, current) || !current.isSocket() || current.uid !== uid()) throw failure('socket_changed');
        await unlink(socketPath);
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(bindPath, () => { server.removeListener('error', reject); resolve(); });
      });
      started = true;
      socketIdentity = await lstat(bindPath);
      await chmod(bindPath, 0o600);
      try { await link(bindPath, socketPath); }
      catch (error) { await new Promise(resolve => server.close(resolve)); started = false; throw error; }
      return { socketPath };
    })();
    return listenPromise;
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (listenPromise) await listenPromise.catch(() => {});
      if (!started) return;
      for (const connection of connections) connection.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      started = false;
      try {
        const current = await lstat(socketPath);
        if (current.isSocket() && current.uid === uid() && sameFile(socketIdentity, current)) await unlink(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return closePromise;
  }
  return { issue, listen, close, peerCommand };
}
