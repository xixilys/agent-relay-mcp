import { randomUUID } from 'node:crypto';

const METHODS = new Set(['initialize', 'notifications/initialized', 'server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe', 'ping']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const STAGES = new Set(['http_entry', 'http_validation', 'parse', 'host', 'authentication', 'resource', 'request',
  'handler', 'tool', 'protocol', 'http_protocol', 'adapter', 'transport', 'request_transport', 'response_transport']);
const CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32000, -32001, -32002, -32015, -32020, -32021, -32022, -32042,
  'invalid_request', 'invalid_token', 'insufficient_scope', 'server_error']);
const defaultWrite = record => process.stderr.write(`${JSON.stringify(record)}\n`);

// Operational metadata only: never copy headers, RPC IDs, arguments, URLs,
// error messages/stacks or arbitrary tool names into service logs.
export function createRequestDiagnostics(req, res, { gateway, write = defaultWrite } = {}) {
  const correlationId = randomUUID();
  const started = performance.now();
  const httpMethod = HTTP_METHODS.has(req.method) ? req.method : 'unknown';
  let method = 'unknown', tool, stage = 'http_entry', code, protocolBranch = 'unclassified';
  function identify(body = req.body) {
    try {
      if (body === undefined) return;
      const rpcMethod = body?.method;
      method = METHODS.has(rpcMethod) ? rpcMethod : 'unknown';
      const name = body?.params?.name;
      tool = method === 'tools/call' && typeof name === 'string' && /^[a-z][a-z_]{0,63}$/.test(name)
        && gateway?.catalog instanceof Map && gateway.catalog.has(name) ? name : undefined;
    } catch { /* Diagnostics cannot reject a request. */ }
  }
  const setStage = value => { stage = STAGES.has(value) ? value : 'unknown'; };
  const setProtocolBranch = value => { protocolBranch = value === 'legacy' || value === 'modern' ? value : 'unclassified'; };
  function emit(event, extra = {}) {
    try {
      identify();
      write({ event, at: new Date().toISOString(), pid: process.pid, correlationId,
        path: '/mcp', httpMethod, method, ...(tool ? { tool } : {}), stage, protocolBranch,
        elapsedMs: Math.round(performance.now() - started), ...(code === undefined ? {} : { code }), ...extra });
    } catch { /* A logger failure must not change the wire result or dispatch. */ }
  }
  function report(stage, error) {
    try {
      setStage(stage);
      const errorCode = error?.code ?? error?.errorCode;
      if (CODES.has(errorCode)) code = errorCode;
      const errorClass = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError'
        : error instanceof SyntaxError ? 'SyntaxError' : error instanceof Error ? 'Error' : 'NonError';
      emit(stage === 'tool' ? 'mcp_tool_error' : 'mcp_request_error', {
        status: res.statusCode, ...(error === undefined ? {} : { errorClass }),
      });
    } catch { /* A logger failure must not change the wire result or dispatch. */ }
  }
  const json = res.json;
  if (typeof json === 'function') res.json = function (body, ...args) {
    try {
      const responseError = body?.error;
      const responseCode = typeof responseError === 'string' ? responseError : responseError?.code;
      if (CODES.has(responseCode)) code = responseCode;
      if (stage === 'http_validation' && responseCode === -32000) setStage('host');
    } catch { /* Observe only fixed codes, without changing JSON serialization. */ }
    return json.call(this, body, ...args);
  };
  // An incomplete HTTP response is an observation, not proof about task state.
  let finished = false, incomplete = false;
  // "finish" confirms the origin finished writing, not that the client received it.
  res.once('finish', () => {
    finished = true;
    if (!incomplete) emit('mcp_http_finish', { status: res.statusCode });
  });
  const transportIncomplete = stage => {
    if (!incomplete && !finished) {
      incomplete = true; report(stage);
      emit('mcp_http_incomplete', { status: res.headersSent ? res.statusCode : null });
    }
  };
  req.once('aborted', () => transportIncomplete('request_transport'));
  res.once('close', () => transportIncomplete('response_transport'));
  try { res.setHeader('x-local-agents-request-id', correlationId); }
  catch { /* Diagnostics must not change a response already started. */ }
  emit('mcp_http_start', { status: null });
  return { correlationId, report, identify, setStage, setProtocolBranch };
}
