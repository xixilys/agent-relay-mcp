import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { LocalAgentsOAuthProvider, SCOPE } from '../src/server.js';
import { createOAuthDiagnostics } from '../src/oauth-diagnostics.js';

async function listen(t, app) {
  const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  return `http://127.0.0.1:${listener.address().port}`;
}

test('OAuth diagnostics capture actual endpoint failures without retaining sensitive values or successes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'local-agents-oauth-diagnostics-'));
  const resource = new URL('https://gateway.example.com/mcp');
  const ownerToken = randomBytes(32).toString('base64url');
  const provider = new LocalAgentsOAuthProvider({ ownerToken, scopes: [SCOPE], allowedRedirectHosts: ['chatgpt.com'], accessTokenTtlSeconds: 60, refreshTokenTtlSeconds: 600 }, resource, dir);
  t.after(async () => { provider.close(); await rm(dir, { recursive: true, force: true }); });
  const records = [];
  const app = express();
  app.use(express.json());
  app.use(createOAuthDiagnostics({ write: record => records.push(record) }));
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(resource.origin), resourceServerUrl: resource, scopesSupported: [SCOPE] }));
  const origin = await listen(t, app);
  const form = (path, values) => fetch(origin + path, { method: 'POST', body: new URLSearchParams(values), redirect: 'manual', headers: { Authorization: 'Bearer private-header-marker' } });
  const register = body => fetch(origin + '/register?private-query-marker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const registration = await register({ client_name: 'private-client-name-marker', redirect_uris: ['http://127.0.0.1:9012/private-redirect-marker'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const params = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: 'private-challenge-marker', code_challenge_method: 'S256', resource: resource.href, scope: SCOPE, state: 'private-state-marker' };
  assert.equal((await fetch(origin + '/authorize?' + new URLSearchParams(params))).status, 200);
  const issued = provider.issueTokens(client.client_id, [SCOPE], resource);
  const refreshed = await form('/token', { client_id: client.client_id, grant_type: 'refresh_token', refresh_token: issued.refresh_token, resource: resource.href });
  assert.equal(refreshed.status, 200);
  const tokens = await refreshed.json();
  assert.deepEqual(records, []);

  assert.equal((await form('/authorize', { ...params, owner_token: 'private-password-marker' })).status, 401);
  assert.equal((await form('/token?private-query-marker', { client_id: 'private-client-id-marker', client_secret: 'private-secret-marker', grant_type: 'refresh_token', refresh_token: 'private-refresh-marker' })).status, 400);
  assert.equal((await form('/token', { client_id: client.client_id, grant_type: 'authorization_code', code: 'private-code-marker', code_verifier: 'private-verifier-marker', redirect_uri: client.redirect_uris[0] })).status, 400);
  assert.equal((await register({ redirect_uris: ['private-malformed-redirect-marker'] })).status, 400);
  assert.equal((await form('/revoke', { client_id: 'private-client-id-marker', token: 'private-revoke-token-marker' })).status, 400);
  assert.equal((await form('/outside', { token: 'private-outside-marker' })).status, 404);
  assert.equal((await form('/revoke', { client_id: client.client_id, token: tokens.access_token })).status, 200);
  assert.equal(records.length, 5);
  assert.deepEqual(records.map(({ path, method, status, grantType, oauthError }) => ({ path, method, status, grantType, oauthError })), [
    { path: '/authorize', method: 'POST', status: 401, grantType: 'unknown', oauthError: null },
    { path: '/token', method: 'POST', status: 400, grantType: 'refresh_token', oauthError: 'invalid_client' },
    { path: '/token', method: 'POST', status: 400, grantType: 'authorization_code', oauthError: 'invalid_grant' },
    { path: '/register', method: 'POST', status: 400, grantType: 'unknown', oauthError: 'invalid_client_metadata' },
    { path: '/revoke', method: 'POST', status: 400, grantType: 'unknown', oauthError: 'invalid_client' },
  ]);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['event', 'at', 'pid', 'path', 'method', 'status', 'grantType', 'oauthError'].sort());
    assert.equal(record.event, 'oauth_http_error');
    assert.equal(record.pid, process.pid);
    assert.equal(new Date(record.at).toISOString(), record.at);
  }
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('private-'));
  for (const secret of [ownerToken, client.client_id, issued.access_token, issued.refresh_token, tokens.access_token, tokens.refresh_token]) assert.ok(!serialized.includes(secret));
});

test('OAuth diagnostics whitelist response errors and grants and preserve text and JSON responses', async t => {
  const records = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createOAuthDiagnostics({ write: record => records.push(record) }));
  app.post('/token', (req, res) => res.status(400).json({ error: req.body.error, error_description: 'private-description-marker', token: 'private-response-token-marker' }));
  app.get('/authorize', (_req, res) => res.status(401).send('private-text-response-marker'));
  app.get('/outside', (_req, res) => res.status(500).json({ error: 'server_error' }));
  const origin = await listen(t, app);
  const response = await fetch(origin + '/token?private-query-marker', { method: 'POST', body: new URLSearchParams({ grant_type: 'private-grant-marker', error: 'private-error-marker', client_id: 'private-client-marker' }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'private-error-marker', error_description: 'private-description-marker', token: 'private-response-token-marker' });
  const text = await fetch(origin + '/authorize?private-query-marker');
  assert.equal(text.status, 401);
  assert.equal(await text.text(), 'private-text-response-marker');
  assert.equal((await fetch(origin + '/outside')).status, 500);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => [record.grantType, record.oauthError]), [['unknown', null], ['unknown', null]]);
  assert.ok(!JSON.stringify(records).includes('private-'));
});

test('OAuth diagnostic logger failures leave the HTTP result unchanged', async t => {
  const app = express();
  app.use(createOAuthDiagnostics({ write: () => { throw new Error('private-logger-error-marker'); } }));
  app.post('/token', (_req, res) => res.status(429).json({ error: 'too_many_requests', error_description: 'private-description-marker' }));
  const origin = await listen(t, app);
  const response = await fetch(origin + '/token', { method: 'POST' });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'too_many_requests', error_description: 'private-description-marker' });
});
