import http from 'node:http';
import net from 'node:net';
import { mkdir, chmod, lstat, link, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { MESSAGE_ID_PATTERN, PEER_ID_PATTERN } from './peer-store.js';

const MAX_BODY = 64 * 1024;
const MAX_BUFFER = 256 * 1024;
const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code),{ code });
const TOOL_NAMES = ['get_peer_message','list_peer_messages','send_peer_message','ack_peer_message'];

export function validateClaudeChannelBinding(binding) {
  if (!object(binding) || Object.keys(binding).sort().join(',') !== 'generation,owner,peerId' ||
      typeof binding.owner !== 'string' || !binding.owner || binding.owner.length > 256 ||
      typeof binding.peerId !== 'string' || !PEER_ID_PATTERN.test(binding.peerId) ||
      !Number.isSafeInteger(binding.generation) || binding.generation < 1) throw fail('invalid_claude_channel_binding');
  return Object.freeze({ ...binding });
}

async function socketInUse(path) {
  return new Promise((resolve,reject) => {
    const socket = net.createConnection({ path });
    socket.setTimeout(300);
    socket.once('connect',() => { socket.destroy(); resolve(true); });
    socket.once('timeout',() => { socket.destroy(); reject(fail('socket_probe_timeout')); });
    socket.once('error',error => { if (error.code === 'ECONNREFUSED') resolve(false); else reject(error); });
  });
}

// Filesystem permissions authorize the OS user. The session UUID only fences
// disconnected adapters; it is neither a bearer credential nor peer identity.
export function createClaudeChannel({ stateDir, binding, peers }) {
  binding = validateClaudeChannelBinding(binding);
  if (!isAbsolute(stateDir) || !peers?.subscribeChannel) throw fail('invalid_claude_channel_options');
  const { owner,peerId,generation } = binding;
  const socketPath = join(stateDir,'claude-channel.sock');
  const bindPath = join(stateDir,`.cc-${randomBytes(6).toString('hex')}.sock`);
  const sockets = new Set();
  let active, unsubscribe, identity, started = false, closed = false, listenPromise, closePromise;
  const authorized = () => {
    if (closed || peers.closed || peers.store.ownerRevoked(owner)) return false;
    const p = peers.store.getPeer(owner,peerId);
    return p?.state === 'active' && p.kind === 'chat' && p.generation === generation;
  };
  const canRead = m => m && ((m.toPeerId === peerId && m.generation === generation) ||
    (m.fromPeerId === peerId && m.fromGeneration === generation));
  const eligible = m => authorized() && m.owner === owner && m.toPeerId === peerId && m.generation === generation &&
    m.processedAt === null && m.deliveryState !== 'cancelled' && peers.isCurrent(m);
  function disconnect(lease = active) {
    if (!lease) return;
    clearInterval(lease.keepalive); clearTimeout(lease.blockTimer);
    if (active === lease) active = undefined;
    lease.response.destroy();
  }
  function write(lease,value) {
    if (active !== lease || !authorized()) { disconnect(lease); return false; }
    if (lease.response.writableLength + Buffer.byteLength(value) > MAX_BUFFER) { disconnect(lease); return false; }
    if (!lease.response.write(value) && !lease.blockTimer) {
      lease.blockTimer = setTimeout(() => disconnect(lease),5000);
      lease.response.once('drain',() => { clearTimeout(lease.blockTimer); lease.blockTimer = undefined; });
    }
    return active === lease;
  }
  function push(m) {
    const lease = active;
    if (!lease || !eligible(m) || lease.seen.has(m.messageId)) return;
    // Reconnect replays original IDs. Bound process memory for indefinitely
    // running sessions; overflow disconnects instead of silently losing data.
    if (lease.seen.size >= 10000) { disconnect(lease); return; }
    if (write(lease,`event: message\ndata: ${JSON.stringify({ messageId: m.messageId,fromPeerId: m.fromPeerId,
      toPeerId: m.toPeerId,fromGeneration: m.fromGeneration,generation: m.generation,
      rootId: m.rootId,hop: m.hop })}\n\n`)) lease.seen.add(m.messageId);
  }
  async function replay(lease,watermark) {
    let after = 0;
    while (active === lease && authorized()) {
      const rows = peers.store.db.prepare(`SELECT rowid AS sequence,message_id FROM peer_messages
        WHERE owner=? AND to_peer_id=? AND to_generation=? AND processed_at IS NULL AND rowid>? AND rowid<=?
        ORDER BY rowid LIMIT 100`).all(owner,peerId,generation,after,watermark);
      if (!rows.length) { write(lease,'event: replay_complete\ndata: {}\n\n'); return; }
      for (const row of rows) {
        if (active !== lease || !authorized()) return;
        push(peers.store.getMessage(owner,row.message_id)); after = row.sequence;
        if (active !== lease) return;
        if (lease.response.writableNeedDrain) await new Promise(resolve => {
          const done = () => { lease.response.removeListener('drain',done); lease.response.removeListener('close',done); resolve(); };
          lease.response.once('drain',done); lease.response.once('close',done);
        });
      }
    }
  }
  const tools = peers.tools().filter(t => TOOL_NAMES.includes(t.name)).map(t => {
    if (t.name === 'list_peer_messages') {
      t.inputSchema.properties.direction = { enum: ['inbox','outbox'],default: 'inbox' };
      t.description = 'List current-generation inbox or outbox metadata, including stable reply IDs for recovery. No read or notification acknowledges processing.';
    }
    for (const name of ['peerId','fromPeerId']) if (t.inputSchema.properties[name]) t.inputSchema.properties[name] = { const: peerId,type: 'string' };
    return t;
  });
  async function call(name,args) {
    if (!authorized()) throw fail('channel_binding_inactive');
    if (!TOOL_NAMES.includes(name) || !object(args)) throw fail('invalid_channel_tool');
    if (name === 'send_peer_message') {
      if (args.fromPeerId !== peerId) throw fail('channel_sender_mismatch');
      return peers.call(name,args,{ owner });
    }
    if (name === 'list_peer_messages') {
      if (args.peerId !== peerId || Object.keys(args).some(k => !['peerId','includeProcessed','limit','direction'].includes(k)) ||
          (args.includeProcessed !== undefined && typeof args.includeProcessed !== 'boolean') ||
          (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) ||
          (args.direction !== undefined && !['inbox','outbox'].includes(args.direction))) throw fail('invalid_channel_tool');
      const outbox = args.direction === 'outbox';
      const rows = peers.store.db.prepare(`SELECT message_id FROM peer_messages WHERE owner=? AND ${outbox ? 'from_peer_id' : 'to_peer_id'}=?
        AND ${outbox ? 'from_generation' : 'to_generation'}=? AND (? OR processed_at IS NULL)
        ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(owner,peerId,generation,args.includeProcessed ? 1 : 0,args.limit ?? 50);
      return { messages: rows.map(row => {
        const { text,deliveries,...metadata } = peers.receipt(peers.store.getMessage(owner,row.message_id));
        return { ...metadata,summary: text.slice(0,200),textLength: text.length };
      }) };
    }
    if (Object.keys(args).some(k => !['messageId',...(name === 'ack_peer_message' ? ['peerId'] : [])].includes(k)) ||
        !MESSAGE_ID_PATTERN.test(args.messageId ?? '')) throw fail('invalid_channel_tool');
    const m = peers.store.getMessage(owner,args.messageId);
    if (!canRead(m)) throw fail('channel_message_not_authorized');
    if (name === 'ack_peer_message' && (args.peerId !== peerId || m.toPeerId !== peerId || m.generation !== generation)) throw fail('channel_recipient_mismatch');
    return peers.call(name,args,{ owner });
  }
  const server = http.createServer(async (request,response) => {
    const reply = (status,value) => { if (!response.destroyed) { response.writeHead(status,{ 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
    const sessionId = request.headers['x-claude-session'];
    if (!authorized()) { reply(403,{ error: 'channel_binding_inactive' }); request.resume(); return; }
    if (typeof sessionId !== 'string' || !MESSAGE_ID_PATTERN.test(sessionId)) { reply(400,{ error: 'invalid_channel_session' }); request.resume(); return; }
    if (request.method === 'GET' && request.url === '/events') {
      if (active) { reply(409,{ error: 'channel_consumer_already_connected' }); return; }
      response.writeHead(200,{ 'content-type': 'text/event-stream','cache-control': 'no-store' });
      const lease = { sessionId,response,seen: new Set() }; active = lease;
      response.once('close',() => { clearInterval(lease.keepalive); clearTimeout(lease.blockTimer); if (active === lease) active = undefined; });
      write(lease,`event: ready\ndata: ${JSON.stringify({ binding,tools })}\n\n`);
      // Capture the replay watermark without yielding after lease assignment.
      // Live pushes cover subsequent inserts; bounded replay batches yield on
      // backpressure so a large inbox cannot repeatedly starve its tail.
      const watermark = peers.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM peer_messages').get().value;
      void replay(lease,watermark).catch(() => disconnect(lease));
      if (active === lease) lease.keepalive = setInterval(() => write(lease,': keepalive\n\n'),15000).unref();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/tool') { reply(404,{ error: 'not_found' }); request.resume(); return; }
    const lease = active;
    if (!lease || lease.sessionId !== sessionId) { reply(403,{ error: 'channel_session_inactive' }); request.resume(); return; }
    let size = 0; const chunks = [];
    try {
      for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) { reply(413,{ error: 'channel_request_too_large' }); request.destroy(); return; } chunks.push(chunk); }
      if (active !== lease || !authorized()) { reply(403,{ error: 'channel_session_inactive' }); return; }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400,{ error: 'invalid_channel_tool' }); return; }
      if (!object(value) || Object.keys(value).sort().join(',') !== 'arguments,name') { reply(400,{ error: 'invalid_channel_tool' }); return; }
      try { reply(200,{ result: await call(value.name,value.arguments) }); }
      catch (error) { reply(200,{ isError: true,error: error.code ?? error.message }); }
    } catch { reply(500,{ error: 'channel_tool_outcome_unknown',retrySafe: false }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.on('connection',socket => { sockets.add(socket); socket.once('close',() => sockets.delete(socket)); });
  server.on('clientError',(_error,socket) => socket.destroy()); server.on('error',() => {});
  async function listen() {
    if (closed) throw fail('channel_closed');
    if (listenPromise) return listenPromise;
    listenPromise = (async () => {
      if (peers.closed) throw fail('channel_closed');
      await mkdir(stateDir,{ recursive: true,mode: 0o700 });
      const directory = await lstat(stateDir);
      if (!directory.isDirectory() || directory.uid !== process.getuid()) throw fail('unsafe_channel_directory');
      await chmod(stateDir,0o700);
      let previous;
      try { previous = await lstat(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        if (!previous.isSocket() || previous.uid !== process.getuid()) throw fail('unsafe_existing_socket');
        if (await socketInUse(socketPath)) throw fail('channel_already_listening');
        const current = await lstat(socketPath);
        if (!sameFile(previous,current) || !current.isSocket() || current.uid !== process.getuid()) throw fail('socket_changed');
        await unlink(socketPath);
      }
      await new Promise((resolve,reject) => { server.once('error',reject); server.listen(bindPath,() => { server.removeListener('error',reject); resolve(); }); });
      started = true; identity = await lstat(bindPath); await chmod(bindPath,0o600);
      try { await link(bindPath,socketPath); } catch (error) { await new Promise(resolve => server.close(resolve)); started = false; throw error; }
      unsubscribe = peers.subscribeChannel(event => {
        if (!authorized()) { disconnect(); return; }
        if (event.type === 'message') push(event.message);
        if (event.type === 'ack' && active && event.message.owner === owner && event.message.toPeerId === peerId && event.message.generation === generation) {
          const lease = active;
          if (write(lease,`event: processed\ndata: ${JSON.stringify({ messageId: event.message.messageId })}\n\n`)) lease.seen.delete(event.message.messageId);
        }
      });
      return { socketPath,binding,state: authorized() ? 'ready' : 'binding_inactive' };
    })();
    return listenPromise;
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (listenPromise) await listenPromise.catch(() => {});
      unsubscribe?.(); disconnect();
      for (const socket of sockets) socket.destroy();
      if (!started) return;
      await new Promise(resolve => server.close(resolve)); started = false;
      try { const current = await lstat(socketPath); if (current.isSocket() && current.uid === process.getuid() && sameFile(identity,current)) await unlink(socketPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return closePromise;
  }
  return { listen,close,socketPath,get state() { return closed ? 'closed' : authorized() ? 'ready' : 'binding_inactive'; } };
}
