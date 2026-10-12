import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayApp, LocalAgentsOAuthProvider, SCOPE } from '../src/server.js';

const PRIVATE = 'PRIVATE_HTTP_DIAGNOSTIC_CANARY';
const VERSION = '2026-07-28';

async function fixture(t, { write } = {}) {
  const dir = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'mcp-http-diagnostics-'));
  await writeFile(join(dir, 'read.txt'), PRIVATE);
  const resource = new URL('https://gateway.example.com/mcp');
  const ownerToken = randomBytes(32).toString('base64url');
  const provider = new LocalAgentsOAuthProvider({ ownerToken, scopes: [SCOPE], allowedRedirectHosts: ['chatgpt.com'], accessTokenTtlSeconds: 60, refreshTokenTtlSeconds: 600 }, resource, join(dir, 'state'));
  const client = provider.clientsStore.registerClient({ client_name: PRIVATE, redirect_uris: ['http://127.0.0.1:9012/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const tokens = provider.issueTokens(client.client_id, [SCOPE], resource);
  const records = [];
  const tools = JSON.parse(await readFile(new URL('./fixtures/paseo-tools.json', import.meta.url), 'utf8'));
  const runtime = await createGatewayApp({ stateDir: join(dir, 'state'), publicBaseUrl: resource.origin, allowedRoots: [dir], direct: { projects: [{ id: 'fixture', path: dir }] } }, {
    oauthProvider: provider, upstream: { async tools() { return tools; } },
    observerFactory: () => ({ watchAgentIds() {}, start() {}, async close() {} }),
    onDiagnostic(record) { records.push(record); write?.(record); },
  });
  const listener = await new Promise(resolve => { const server = runtime.app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => listener.close(resolve)); await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  async function rpc(method, params = {}, { modern = true, token = tokens.access_token, headers = {}, body, path = '/mcp?' + PRIVATE } = {}) {
    const requestHeaders = { 'content-type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}), 'x-local-agents-request-id': PRIVATE };
    if (modern) {
      requestHeaders['mcp-protocol-version'] = VERSION;
      requestHeaders['mcp-method'] = method;
      if (method === 'tools/call') requestHeaders['mcp-name'] = params.name;
    }
    const message = { jsonrpc: '2.0', id: PRIVATE, method, params: { ...params, ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } };
    const payload = body ?? JSON.stringify(message);
    if (headers.Host) {
      return new Promise((resolve, reject) => {
        const request = httpRequest(origin + path, { method: 'POST', headers: { ...requestHeaders, ...headers } }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode,
            id: response.headers['x-local-agents-request-id'], headers: new Headers(response.headers),
            body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        request.on('error', reject); request.end(payload);
      });
    }
    const response = await fetch(origin + path, { method: 'POST', headers: { ...requestHeaders, ...headers }, body: payload });
    return { status: response.status, id: response.headers.get('x-local-agents-request-id'), headers: response.headers, body: await response.json() };
  }
  function lifecycle(response) {
    const found = records.filter(record => record.correlationId === response.id);
    assert.equal(found.filter(record => record.event === 'mcp_http_start').length, 1);
    assert.equal(found.filter(record => record.event === 'mcp_http_finish').length, 1);
    assert.equal(found.filter(record => record.event === 'mcp_http_incomplete').length, 0);
    const finish = found.find(record => record.event === 'mcp_http_finish');
    assert.equal(finish.status, response.status);
    return { found, finish };
  }
  function privateCheck() {
    const serialized = JSON.stringify(records);
    for (const secret of [PRIVATE, ownerToken, client.client_id, tokens.access_token, tokens.refresh_token, dir]) assert.ok(!serialized.includes(secret));
    const fields = new Set(['event', 'at', 'pid', 'correlationId', 'path', 'httpMethod', 'method', 'tool', 'stage', 'protocolBranch', 'elapsedMs', 'code', 'status', 'errorClass']);
    for (const record of records) {
      for (const field of Object.keys(record)) assert.ok(fields.has(field), field);
      assert.equal(record.path, '/mcp');
      assert.equal(record.httpMethod, 'POST');
      assert.ok(['unclassified', 'legacy', 'modern'].includes(record.protocolBranch));
      assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
      assert.equal(new Date(record.at).toISOString(), record.at);
    }
  }
  return { rpc, lifecycle, privateCheck, records, runtime, provider, client, tokens, origin, listener };
}

test('HTTP ingress diagnostics cover SDK JSON and Host rejection, bearer 401 and verifier 500', async t => {
  const f = await fixture(t);
  const unauthenticated = await f.rpc('tools/list', {}, { token: null });
  assert.equal(unauthenticated.status, 401);
  assert.equal(f.lifecycle(unauthenticated).finish.stage, 'authentication');
  assert.equal(f.lifecycle(unauthenticated).finish.code, 'invalid_token');
  assert.equal(f.lifecycle(unauthenticated).finish.protocolBranch, 'unclassified');
  const verify = f.provider.verifyAccessToken;
  f.provider.verifyAccessToken = () => { throw new Error(PRIVATE); };
  const verifierFailure = await f.rpc('tools/list');
  f.provider.verifyAccessToken = verify;
  assert.equal(verifierFailure.status, 500);
  assert.equal(f.lifecycle(verifierFailure).finish.stage, 'authentication');
  assert.equal(f.lifecycle(verifierFailure).finish.code, 'server_error');
  assert.equal(verifierFailure.body.error, 'server_error');
  const malformed = await f.rpc('tools/list', {}, { body: '{"' + PRIVATE });
  assert.equal(malformed.status, 400);
  assert.equal(f.lifecycle(malformed).finish.stage, 'parse');
  assert.equal(f.lifecycle(malformed).finish.method, 'unknown');
  assert.ok(f.lifecycle(malformed).found.some(record => record.event === 'mcp_request_error' && record.stage === 'parse'));
  const oversized = await f.rpc('tools/list', {}, { body: JSON.stringify({ value: PRIVATE.repeat(5000) }) });
  assert.equal(oversized.status, 400);
  assert.equal(f.lifecycle(oversized).finish.stage, 'parse');
  const badHost = await f.rpc('tools/list', {}, { headers: { Host: PRIVATE + '.example' } });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.body.error.code, -32000);
  assert.equal(f.lifecycle(badHost).finish.stage, 'host');
  assert.equal(f.lifecycle(badHost).finish.code, -32000);
  const foreign = f.provider.issueTokens(f.client.client_id, [SCOPE], new URL('https://other.example/mcp'));
  const resource = await f.rpc('tools/list', {}, { token: foreign.access_token });
  assert.equal(resource.status, 401);
  assert.equal(f.lifecycle(resource).finish.stage, 'resource');
  const before = f.records.length;
  assert.equal((await fetch(f.origin + '/healthz?' + PRIVATE)).status, 200);
  assert.equal(f.records.length, before);
  assert.equal(unauthenticated.headers.get('x-powered-by'), null);
  f.privateCheck();
});

test('MCP aliases use the same ingress matcher before authentication and on both protocol branches', async t => {
  const f = await fixture(t);
  for (const path of ['/mcp/', '/MCP']) {
    const refused = await f.rpc('tools/list', {}, { path: path + '?' + PRIVATE, token: null });
    assert.equal(refused.status, 401);
    assert.ok(refused.id);
    assert.equal(f.lifecycle(refused).finish.stage, 'authentication');
    assert.equal(f.lifecycle(refused).finish.protocolBranch, 'unclassified');
    for (const modern of [true, false]) {
      const listed = await f.rpc('tools/list', {}, { path: path + '?' + PRIVATE, modern });
      assert.equal(listed.status, 200);
      assert.ok(listed.id);
      assert.ok(listed.body.result.tools.some(tool => tool.name === 'read_direct_file'));
      assert.equal(f.lifecycle(listed).finish.method, 'tools/list');
      assert.equal(f.lifecycle(listed).finish.protocolBranch, modern ? 'modern' : 'legacy');
    }
  }
  const before = f.records.length;
  for (const path of ['/healthz', '/mcp-other', '/mcp/nested']) {
    const response = await fetch(f.origin + path + '?' + PRIVATE);
    assert.equal(response.status, path === '/healthz' ? 200 : 404);
    assert.equal(response.headers.get('x-local-agents-request-id'), null);
  }
  assert.equal(f.records.length, before);
  f.privateCheck();
});

test('modern and legacy success and ordinary tool isError share one lifecycle and isolate concurrent IDs', async t => {
  const f = await fixture(t);
  const read = { name: 'read_direct_file', arguments: { projectId: 'fixture', path: 'read.txt' } };
  const missing = { name: 'read_direct_file', arguments: { projectId: 'fixture', path: PRIVATE + '.missing' } };
  for (const modern of [true, false]) {
    const listed = await f.rpc('tools/list', {}, { modern });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.result.tools.some(tool => tool.name === read.name));
    assert.equal(f.lifecycle(listed).finish.method, 'tools/list');
    assert.equal(f.lifecycle(listed).finish.protocolBranch, modern ? 'modern' : 'legacy');
    const success = await f.rpc('tools/call', read, { modern });
    assert.equal(success.status, 200);
    assert.notEqual(success.body.result.isError, true, JSON.stringify(success.body.result));
    assert.ok(JSON.stringify(success.body.result).includes(PRIVATE));
    assert.equal(f.lifecycle(success).finish.tool, read.name);
    assert.ok(!f.lifecycle(success).found.some(record => record.event.endsWith('_error')));
    const rejected = await f.rpc('tools/call', missing, { modern });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.result.isError, true);
    assert.equal(f.lifecycle(rejected).finish.stage, 'tool');
    assert.equal(f.lifecycle(rejected).finish.protocolBranch, modern ? 'modern' : 'legacy');
    assert.equal(f.lifecycle(rejected).found.filter(record => record.event === 'mcp_tool_error').length, 1);
  }
  const responses = await Promise.all([f.rpc('tools/call', read), f.rpc('tools/call', missing)]);
  assert.notEqual(responses[0].id, responses[1].id);
  assert.equal(f.lifecycle(responses[0]).finish.stage, 'handler');
  assert.equal(f.lifecycle(responses[1]).finish.stage, 'tool');
  const starts = f.records.filter(record => record.event === 'mcp_http_start');
  assert.equal(new Set(starts.map(record => record.correlationId)).size, starts.length);
  f.privateCheck();
});

test('throwing lifecycle logger preserves authentication, parsing and tool HTTP results', async t => {
  const f = await fixture(t, { write() { throw new Error(PRIVATE); } });
  assert.equal((await f.rpc('tools/list', {}, { token: null })).status, 401);
  assert.equal((await f.rpc('tools/list', {}, { body: '{' })).status, 400);
  const verify = f.provider.verifyAccessToken;
  f.provider.verifyAccessToken = () => { throw new Error(PRIVATE); };
  assert.equal((await f.rpc('tools/list')).status, 500);
  f.provider.verifyAccessToken = verify;
  const listed = await f.rpc('tools/list');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.result.tools));
  const rejected = await f.rpc('tools/call', { name: 'read_direct_file', arguments: { projectId: 'fixture', path: 'missing' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.result.isError, true);
  f.privateCheck();
});

test('nonallowlisted RPC methods, tool names and error codes are omitted from diagnostics', async t => {
  const f = await fixture(t);
  const unknown = await f.rpc(PRIVATE + '/call');
  assert.equal(unknown.body.error.code, -32601);
  assert.equal(f.lifecycle(unknown).finish.method, 'unknown');
  const tool = await f.rpc('tools/call', { name: PRIVATE, arguments: { text: PRIVATE } });
  assert.equal(tool.body.result.isError, true);
  assert.equal(f.lifecycle(tool).finish.tool, undefined);
  f.runtime.gateway.call = () => { throw Object.assign(new Error(PRIVATE), { code: -32123 }); };
  const error = await f.rpc('tools/call', { name: 'read_direct_file', arguments: { projectId: 'fixture', path: 'read.txt' } });
  assert.equal(error.body.result.isError, true);
  assert.ok(f.lifecycle(error).found.every(record => record.code !== -32123));
  f.privateCheck();
});

test('an actual incomplete request body records one request interruption before JSON parsing', { timeout: 10000 }, async t => {
  let started, interrupted;
  const start = new Promise(resolve => { started = resolve; });
  const incomplete = new Promise(resolve => { interrupted = resolve; });
  const f = await fixture(t, { write(record) {
    if (record.event === 'mcp_http_start') started();
    if (record.event === 'mcp_http_incomplete') interrupted(record);
  } });
  const request = httpRequest(f.origin + '/mcp?' + PRIVATE, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '10000' } });
  request.on('error', () => {});
  request.write('{"' + PRIVATE);
  await start;
  request.destroy();
  const record = await incomplete;
  assert.equal(record.stage, 'request_transport');
  assert.equal(record.status, null);
  assert.equal(f.records.filter(item => item.event === 'mcp_http_incomplete').length, 1);
  assert.equal(f.records.filter(item => item.event === 'mcp_http_finish').length, 0);
  f.privateCheck();
});

test('concurrent completion and response interruption stay separate on modern and legacy HTTP paths', { timeout: 10000 }, async t => {
  let interrupted;
  const f = await fixture(t, { write(record) { if (record.event === 'mcp_http_incomplete') interrupted(record); } });
  const call = f.runtime.gateway.call.bind(f.runtime.gateway);
  for (const modern of [true, false]) {
    let entered, release, completed;
    const entry = new Promise(resolve => { entered = resolve; });
    const continuation = new Promise(resolve => { release = resolve; });
    const incomplete = new Promise(resolve => { interrupted = resolve; });
    const done = new Promise(resolve => { completed = resolve; });
    let dispatched = 0;
    f.runtime.gateway.call = async (...args) => {
      dispatched++; entered(); await continuation;
      try { return await call(...args); } finally { completed(); }
    };
    const controller = new AbortController();
    const headers = { 'content-type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + f.tokens.access_token };
    const params = { name: 'read_direct_file', arguments: { projectId: 'fixture', path: 'read.txt' } };
    if (modern) {
      headers['mcp-protocol-version'] = VERSION; headers['mcp-method'] = 'tools/call'; headers['mcp-name'] = params.name;
      params._meta = { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
    }
    const pending = fetch(f.origin + '/mcp?' + PRIVATE, { method: 'POST', signal: controller.signal, headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: PRIVATE, method: 'tools/call', params }) });
    await entry;
    const completedResponse = await f.rpc('tools/list', {}, { modern });
    assert.equal(completedResponse.status, 200);
    assert.equal(f.lifecycle(completedResponse).finish.protocolBranch, modern ? 'modern' : 'legacy');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const record = await incomplete;
    release(); await done;
    assert.equal(record.stage, 'response_transport');
    assert.equal(record.status, null);
    assert.equal(record.protocolBranch, modern ? 'modern' : 'legacy');
    assert.notEqual(record.correlationId, completedResponse.id);
    assert.equal(dispatched, 1);
    const own = f.records.filter(item => item.correlationId === record.correlationId);
    assert.equal(own.filter(item => item.event === 'mcp_http_start').length, 1);
    assert.equal(own.filter(item => item.event === 'mcp_http_incomplete').length, 1);
    assert.equal(own.filter(item => item.event === 'mcp_http_finish').length, 0);
  }
  f.privateCheck();
});
