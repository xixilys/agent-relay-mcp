#!/usr/bin/env node
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_AGENT_STATE_DIR, AGENT_ID_PATTERN, REQUEST_ID_PATTERN,
  MAX_PEER_BODY_BYTES, PEER_TOOL_NAMES, readAgentCapability, validatePeerRequest } from '../src/agent-channel.js';

function parse(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--request-id', '--tool'].includes(flag) || Object.hasOwn(values, flag) || i + 1 === args.length) throw Error();
    values[flag] = args[++i];
  }
  if (!REQUEST_ID_PATTERN.test(values['--request-id'] ?? '') || !PEER_TOOL_NAMES.includes(values['--tool'])) throw Error();
  return values;
}
async function readArguments(input, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const chunks = []; let size = 0;
        for await (const chunk of input) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_PEER_BODY_BYTES) throw Error('input_too_large');
          chunks.push(bytes);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
        return value;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(Error('input_timeout')); input.destroy?.(); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
function submit(socketPath, key, value, bytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = http.request({ socketPath, method: 'POST', path: '/peer-mcp', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': bytes.length,
    } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) request.destroy(Error('invalid_response'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(Error('response_aborted')));
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(Object.assign(Error('rejected'), { statusCode: response.statusCode })); return;
        }
        try {
          const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!rpc || rpc.jsonrpc !== '2.0' || rpc.id !== value.rpc.id ||
              !rpc.result || typeof rpc.result !== 'object' || Array.isArray(rpc.result) || rpc.error !== undefined) throw Error();
          resolve(rpc);
        } catch { reject(Error('invalid_response')); }
      });
    });
    request.once('error', reject);
    request.once('close', () => clearTimeout(timer));
    timer = setTimeout(() => request.destroy(Error('network_timeout')), timeoutMs);
    request.end(bytes);
  });
}

// Test/embedding injection only. The executable cannot select another agent,
// capability file, socket, owner, host, or authentication provider.
export async function runPeerAgent(args, { env = process.env, stateDir = DEFAULT_AGENT_STATE_DIR,
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  networkTimeoutMs = 15000, inputTimeoutMs = 5000 } = {}) {
  let value, bytes;
  try {
    const options = parse(args);
    if (!AGENT_ID_PATTERN.test(env.PASEO_AGENT_ID ?? '')) throw Error();
    value = validatePeerRequest({ agentId: env.PASEO_AGENT_ID, requestId: options['--request-id'], rpc: {
      jsonrpc: '2.0', id: options['--request-id'], method: 'tools/call',
      params: { name: options['--tool'], arguments: await readArguments(stdin, inputTimeoutMs) },
    } });
    bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_PEER_BODY_BYTES) throw Error();
  } catch {
    stderr.write(`${JSON.stringify({ status: 'invalid_input', safe_code: 'invalid_input', retrySafe: false })}\n`);
    return 2;
  }
  let key;
  try { key = await readAgentCapability(stateDir, value.agentId); }
  catch {
    stderr.write(`${JSON.stringify({ status: 'unauthorized', safe_code: 'capability_unavailable', retrySafe: false })}\n`);
    return 1;
  }
  try {
    const result = await submit(join(stateDir, 'agent-channel.sock'), key, value, bytes, networkTimeoutMs);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.result.isError === true ? 1 : 0;
  } catch (error) {
    const safe = ['EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED'];
    const safe_code = safe.includes(error.code) ? error.code :
      error.statusCode && error.statusCode < 500 ? `http_${error.statusCode}` :
      ['network_timeout', 'response_aborted', 'invalid_response'].includes(error.message) ? error.message : 'peer_call_outcome_unknown';
    const unknown = !(safe.includes(error.code) || (error.statusCode && error.statusCode < 500));
    stderr.write(`${JSON.stringify({ status: unknown ? 'outcome_unknown' : 'rejected', safe_code, retrySafe: false })}\n`);
    if (unknown) stderr.write('Outcome unknown. Read get_peer_message with the original messageId; do not send a new messageId or automatically replay the call.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runPeerAgent(process.argv.slice(2));
