# Security

## Trust boundary

Agent Relay MCP is intended for one trusted user, with one Mac gateway and explicitly configured local/SSH hosts. Authorizing an OAuth client grants meaningful agent and configured Direct Workspace authority on those hosts. It is not suitable as a shared public service for untrusted tenants.

`allowedRoots` resolves real paths and rejects out-of-scope targets and symlink escapes. It is a gateway path check, not an OS sandbox: an agent can execute commands using its own runtime permissions. Generic agent reads, cancellation, updates and permission responses use the shared allowed-root authority domain. In the default per-client mode, client ownership additionally isolates collaboration request records, messages, subscriptions, reply claims and Direct command receipts, not every agent or project-file operation. Direct projects are owner-configured per host, with separate read/write permissions and disabled/registered/full command modes. Registered commands match exact argv; full commands execute with the gateway account's system access and can act outside the initial project directory. Do not treat project roots as command containment. File writes use optimistic hashes and atomic replacement, not a kernel compare-and-swap against unrelated writers.

Only proxy the OAuth-protected gateway, bound to `127.0.0.1:6768`. Keep Paseo's unauthenticated loopback agent endpoint private. Exposing the upstream would bypass the gateway's authentication and path policy. Use HTTPS and request/rate limits at your proxy, protect the owner password, and grant client consent only intentionally. This gateway has no built-in multi-tenant quotas or comprehensive abuse protection.

The gateway trusts forwarded addresses only from loopback proxy hops. The SDK's OAuth rate limits remain enabled and use the nearest untrusted source address; a forged value further left in `X-Forwarded-For` does not create a new bucket. Clients behind the same source IP can still share a limit. Keep the loopback listener private and use your existing local reverse proxy.

Remote agents use the existing owner-configured OpenSSH target and pinned Paseo identity. Direct file/command access uses SSH independently of Paseo availability. The private reverse message socket grants only per-agent capabilities; no public agent-message ingress is added. Keep each host's state directory separate and do not copy old receipts to another host identity. Only gateway-owned command process groups are stopped by cancellation or close; gateway restart does not promise process continuity, and uncertain requests/inputs are not replayed.

With `sharedOwner: true`, all authenticated clients share one authority domain for peer directories/messages, collaboration records, subscriptions, Direct command receipts and file transfers. The example configuration enables this for trusted clients belonging to the same user. Omitting the setting or using `false` retains per-client record isolation. Generic agent and configured project access already use the shared allowed-root authority domain; per-client record isolation is not a complete tenant boundary. Migrating existing state requires an offline backup and the supplied migration script; turning off shared mode does not undo the migration. Keep the private backups and reconcile any subsequent activity before restoring old state.

Chat/dot peer IDs and OAuth sender labels are claimed logical identities, not verified conversation identities; an authorized OAuth client in that owner scope can claim a sender ID. Native peer calls additionally check the existing agent capability, dispatch ownership, host binding, active peer generation and historical revocation cutoff. Registering a local peer binds an already-owned agent and does not create one. Treat peer messages as untrusted data within existing authorization. Retained mailbox history does not impose a cumulative message-count quota; operators remain responsible for storage capacity and private backups.

## Private data

Keep config, owner passwords, OAuth state, message/result databases, callbacks and per-agent capabilities outside source control. The state directory is private to the service user, with private capability files/socket. It is not encrypted at rest; protect backups and access by other processes of the same OS user. The agent channel cannot enforce isolation against that same user.

Never put credentials, callback secrets or unnecessary personal/research data in an agent message. Events contain agent-authored summaries and identifiers, and read tools can return full task content. A subscribed callback receives those events. Validate signed callbacks and handle messages as untrusted input within the original task's scope.

OAuth-route failures record only a fixed endpoint path, method, HTTP status, supported grant type, allowlisted OAuth error code, time and gateway PID. Tokens, client IDs, IPs, headers, query strings and error descriptions are not logged. These records cover failures that reach the OAuth routes, not upstream connection failures or the SDK's earlier JSON/Host checks. Missing records alone do not establish why a client could not renew its token.

For `/mcp`, a separate lifecycle record starts before JSON parsing, Host validation and bearer authentication. It records a generated correlation ID, fixed method/tool names and protocol branch, status, elapsed time, failure stage and allowlisted codes. Each request ends with an origin finish or an incomplete response; a finish does not prove client receipt. Arguments, message content, credentials, client IDs, IPs, headers, queries, raw RPC IDs and exception text are excluded. These records do not cover failures before the request reaches the gateway, and missing records alone do not prove a network cause.

## Events and recovery

MCP Events callback verification uses a signed challenge. Outbound delivery checks every resolved address, rejects non-public destinations and redirects, pins the checked address for TLS, and bounds time and response size. Subscriptions and replies are associated with the authenticated authority domain and their workspace or peer. Expired/stopped subscriptions cease delivery. Per-client OAuth token revocation remains active in either mode; in shared mode, disconnecting one client does not revoke the other clients' shared resources.

Grok Bot routine webhooks are a separate notification transport with a private bearer key and no MCP callback challenge. The administrator binds an exact owner, peer generation and routine in private configuration. Notifications contain identifiers rather than message text. Each message has one persistent delivery claim; a lost response is recorded as unknown and is not automatically resent. Keep the routine URL, bearer key and binding files outside source control. A routine should read its inbox through its existing authenticated MCP connection and treat message text as untrusted data.

Delivery is not task acceptance. Preserve event/message/request IDs and deduplicate client actions. If dispatch or IPC receipts are uncertain, inspect/recover the original ID rather than resending as new work. A sandbox denying the fixed IPC command is a permission problem; do not bypass it by changing global permissions.

## Reporting a vulnerability

Do not attach private configs, state files, tokens, sessions or callback URLs to a public issue. Use the repository's private vulnerability reporting feature when available. Otherwise open an issue with a non-sensitive summary to request a private reporting channel. Include a minimal synthetic reproduction and affected version.

## Dependency audit retained from 0.3.0

The public snapshot updates the directly used AJV to 8.20.0 and declares Zod explicitly. The separately installed DevSpace package also includes provider branches unused by this gateway: `sandbox-runtime → node-forge` and `pi-coding-agent → undici / brace-expansion / protobufjs`. npm audit reports advisories for those packages and their parents. At the 0.3.0 audit, a patched Forge release was not available; the other branch versions remain the upstream package's locked versions.

The gateway imports only DevSpace's OAuth provider/store/database modules. The affected provider branches are outside that import graph and are not started here. This limits the identified exposure; it is not proof that the entire dependency tree is vulnerability-free, nor a security endorsement for using those provider modules separately. Do not extend the gateway to import/run them without first resolving and reviewing their advisories. We retain the tested authentication implementation rather than introducing a fork or unverified vendor rewrite solely to suppress audit output.

References: [Forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [Undici security advisories](https://github.com/nodejs/undici/security/advisories), [brace-expansion advisory](https://github.com/advisories/GHSA-rgw5-rvv9-x895), [protobufjs advisory](https://github.com/advisories/GHSA-j3f2-48v5-ccww). Re-run `npm audit --omit=dev` when evaluating deployment because advisory and release availability can change.
