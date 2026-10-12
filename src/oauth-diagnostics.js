const PATHS = new Set(['/authorize', '/token', '/register', '/revoke']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const GRANTS = new Set(['authorization_code', 'refresh_token']);
const ERRORS = new Set([
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error',
  'temporarily_unavailable', 'unsupported_response_type', 'unsupported_token_type',
  'invalid_token', 'method_not_allowed', 'too_many_requests', 'invalid_client_metadata',
  'insufficient_scope', 'invalid_target',
]);
const defaultWrite = record => process.stderr.write(`${JSON.stringify(record)}\n`);

// Only fixed operational values leave the request: never log input, URLs,
// headers, identifiers, tokens, error descriptions or stacks.
export function createOAuthDiagnostics({ write = defaultWrite } = {}) {
  return (req, res, next) => {
    if (!PATHS.has(req.path)) { next(); return; }
    const path = req.path;
    const method = METHODS.has(req.method) ? req.method : 'unknown';
    let oauthError = null;
    const json = res.json;
    res.json = function (body, ...args) {
      try {
        const error = body?.error;
        oauthError = ERRORS.has(error) ? error : null;
      }
      catch { oauthError = null; }
      return json.call(this, body, ...args);
    };
    res.once('finish', () => {
      if (res.statusCode < 400) return;
      try {
        const grant = req.body?.grant_type;
        write({ event: 'oauth_http_error', at: new Date().toISOString(), pid: process.pid,
          path, method, status: res.statusCode,
          grantType: GRANTS.has(grant) ? grant : 'unknown', oauthError });
      } catch { /* Diagnostics must not change the HTTP response. */ }
    });
    next();
  };
}
