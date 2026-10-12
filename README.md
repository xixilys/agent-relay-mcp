<p align="center">
  <img src="docs/assets/banner.svg?v=chat-relay-20261012" alt="Agent Relay MCP — connect dot, Grok Bot and GPT chats" width="100%">
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · English
</p>

<p align="center">
  <a href="NOTICE"><img alt="MIT and Apache-2.0 licenses" src="https://img.shields.io/badge/licenses-MIT%20%2B%20Apache--2.0-14b8a6.svg"></a>
  <a href="https://github.com/xixilys/agent-relay-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xixilys/agent-relay-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/Node.js-22.19%E2%80%9326-2563eb.svg">
</p>

**Let dot, Grok Bot, and your GPT chats (ChatGPT) find each other, exchange messages, and follow the same conversation through a shared peer mailbox.** Agent Relay MCP provides one self-hosted, OAuth-protected endpoint for your trusted clients, with linked replies, explicit processing ACKs, and notifications matched to each recipient’s capabilities.

With `sharedOwner: true`, clients use the same peer directory and can communicate across OAuth client connections. A compatible dot conversation can wake through MCP Events; Grok Bot can wake through its official Webhook routine. Ordinary GPT chats use MCP tools to check their inbox manually; automatic wake applies only to ChatGPT clients that actually support Events and have an active subscription.

Paseo agent dispatch, Direct files/commands/binary transfers, and Mac/SSH host routing support that communication when a conversation needs local work or artifacts. This gateway is for one trusted owner; agents run with their selected host’s Paseo installation and runtime permissions. It does not provide model accounts, a hosted service, or an operating-system sandbox.

![Trusted dot, Grok Bot and GPT chat clients communicate through a shared peer directory, with capability-specific notifications and optional Mac/SSH execution.](docs/assets/host-topology.svg?v=chat-relay-20261012)

## What it does

- **dot ↔ Grok Bot ↔ GPT chats.** Register stable peer IDs, discover recipients with `list_peers`, send messages, and connect a reply to the original message with `inReplyTo`. Read the exact message through MCP and ACK it when processed. An ACK records processing state; it does not itself prove a chat read the text or completed the requested work. Retained history does not block new mail at a cumulative message-count limit.
- **Wake where the client supports it.** Subscribe a compatible dot/ChatGPT conversation to `peer.message` through MCP Events, or configure a Grok Bot official Webhook routine to read its inbox. Ordinary GPT chats check mail manually. A callback HTTP 200 proves only acceptance at that endpoint; verify the recipient’s actual read. Native agents receive queued mail when idle.
- **Shared access for your trusted clients.** `sharedOwner: true` shares the peer directory and mailboxes across authenticated clients, along with existing agent tasks and Direct commands/files/transfers. OAuth authentication and per-client token revocation remain active. Omit this option or set it to `false` to keep the original per-OAuth-client authority domains. Peer message text remains data, not new user authorization.
- **Local work and artifacts alongside the conversation.** Dispatch existing Paseo agents, read task receipts, use project-scoped Direct files and commands, and transfer binary files. The gateway connects to your existing Mac Paseo instance and explicitly configured SSH hosts; it does not inherit the desktop UI’s host list, install or start remote Paseo, or change providers or credentials.
- **Explicit host selection and host-local history.** `list_hosts` reports configured `hostId`, name, and availability. Host-routed tools accept `hostId`; omitted calls keep their legacy Mac behavior. Keep the same host for subsequent result/event reads. Projects, workspaces, agents and task receipts retain host-local IDs; peer mailboxes use the owner-wide directory. Only local peer registration takes `hostId` to bind an agent.
- **Remote agent messages return to the gateway.** A fixed CLI on the remote host reaches its dedicated Mac-side channel through a reverse SSH Unix-socket forward. The Mac gateway centrally persists messages without adding a public message endpoint.

## Quick start

The example below is a shape guide for the 0.6.0 multi-host configuration. Replace every example path and host value with values you control. The Mac is implicit; list only additional remote hosts.

```sh
git clone https://github.com/xixilys/agent-relay-mcp.git
cd agent-relay-mcp
npm ci --ignore-scripts
cp config.example.json config.json
```

Configure one OAuth gateway and your hosts. Keep the existing Mac settings as top-level fields; add remote hosts in `hosts`:

```json
{
  "publicBaseUrl": "https://gateway.example.com",
  "port": 6768,
  "sharedOwner": true,
  "upstreamUrl": "http://127.0.0.1:6767/mcp/agents",
  "stateDir": "/Users/you/.local/share/local-agents-mcp",
  "ownerTokenFile": "/Users/you/.local/share/local-agents-mcp/owner.json",
  "paseoCommand": "/Applications/Paseo.app/Contents/Resources/bin/paseo",
  "allowedRoots": ["/Users/you/Projects"],
  "hosts": [
    {
      "id": "wsl",
      "name": "WSL",
      "transport": "ssh",
      "target": "ssh://linux-host",
      "allowedRoots": ["/home/you/project"],
      "remoteStateDir": "/home/you/.local-agents-mcp-bridge/gateway"
    }
  ]
}
```

Create the private owner-password file in the Mac state directory before starting the service. Keep the password and state outside source control. The gateway process and local Paseo instance must run as the same Mac user. Each remote host must already have Paseo installed and running, and the configured SSH identity must be able to reach it using your normal OpenSSH authentication setup. Remote `allowedRoots` are checked on the remote host after resolving canonical paths; this is a path policy, not an OS sandbox. Choose `remoteStateDir` and its parent with permissions that pass the bridge's private-directory checks; existing directories are not automatically made private.

On macOS, the local Paseo observer helpers use the app's Electron runtime and bundled client. The original supported setup is Paseo **0.10.3** at `/Applications/Paseo.app`; other versions or installation paths need verification. The gateway requires Node.js `>=22.19 <27`, npm, and `better-sqlite3` **13.0.3**, which ships Node-API prebuilt binaries. `npm ci --ignore-scripts` keeps dependency lifecycle scripts disabled; supported prebuilt platforms need no manual native rebuild. Unsupported platforms or an intentional source build may require a C/C++ toolchain, Python, and official Node headers.

```sh
npm run check
npm test
npm start
```

Run one gateway for the configured port and state. Put an HTTPS reverse proxy in front of the gateway at `127.0.0.1:6768`, preserve authorization and MCP headers, and connect a compatible client to `https://<your-origin>/mcp`. TLS, proxy limits, service management, and client registration are operator responsibilities. Keep Paseo's loopback endpoint private. The repository does not provision a tunnel or change firewall rules.

OAuth clients are dynamically registered. Authorization uses the `local-agents` scope, S256 PKCE, and the exact MCP resource URL (`https://<your-origin>/mcp`). Access tokens last one hour and refresh tokens 30 days. Redirects allow `chatgpt.com`, `chat.openai.com`, `www.cursor.com`, and loopback hosts (`localhost`, `127.0.0.1`, `::1`); other redirect hosts require a deliberate source change. Apply proxy rate limits to registration and consent endpoints before exposing the service.

<details>
<summary>Owner password file example</summary>

This creates a private file and refuses to overwrite an existing one:

```sh
node --input-type=module <<'NODE'
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const dir = join(homedir(), '.local', 'share', 'local-agents-mcp');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
await writeFile(join(dir, 'owner.json'), JSON.stringify({
  ownerToken: randomBytes(32).toString('base64url')
}) + '\n', { mode: 0o600, flag: 'wx' });
NODE
```

</details>

## Shared access and mailbox wake

The fresh-install example enables `sharedOwner: true` for a single user’s trusted clients. This setting uses `local-owner:shared` for all authenticated OAuth clients, including peer directories, existing agent tasks, Direct commands, files and transfer receipts. It does not relax OAuth verification, native agent capabilities, project permissions or existing task authorization. Revoking one client’s tokens leaves other clients’ shared resources available. Without this setting, the original `local-owner:<clientId>` domains remain separate.

### Upgrade an existing installation

Stop the gateway using its existing service manager before migrating; do not run migration against a live state directory. Resolve any in-flight Direct commands, binary transfers or native peer deliveries first. Save the old private configuration and wake bindings separately, then run from the repository with the actual state directory and a new backup directory:

```sh
python3 scripts/migrate-shared-owner.py \
  --state-dir /Users/you/.local/share/local-agents-mcp \
  --backup-dir /Users/you/.local/share/agent-relay-migration-backup \
  --apply
```

After successful migration, set `sharedOwner: true` in `config.json`, change the `owner` of any private `peerWakeTargets` entry to `local-owner:shared`, and start one gateway. Check `list_hosts`, `list_peers` and the original receipts from each client. Existing subscription IDs, message text and processing state, receipt history, legacy agent revocations, and Webhook watermarks/claims are preserved; unknown operations are not resent. Conflicting live/bound peer identities or message IDs stop migration; conflicting stopped, unbound peer names may receive an archive suffix. The script does not change OAuth credentials or start agents.

Backups contain private state and must remain outside Git. If migration fails, keep the gateway stopped and restore every backed-up database/receipt file before restarting with the saved configuration. Once shared mode has received new data, restoring an older backup can lose it; simply toggling the option back does not migrate shared history into separate client domains.

### Select the recipient’s notification path

| Recipient capability | Setup | What to verify |
| --- | --- | --- |
| Native Paseo agent | Register `kind: "local"` with its existing owned `hostId` and `agentId`. | Busy mail queues until idle; inspect the original message and actual agent result. |
| MCP Events client, including a compatible dot conversation | Register a peer, then call `events/subscribe` in that recipient conversation for `peer.message`, with `arguments: {"peerId":"dot","generation":1}` using its actual ID/generation and the platform-provided callback/signing secret. | Keep unrelated `agent.attention` subscriptions. Confirm the recipient reads the original mail without another user prompt. |
| Grok Bot with an official Webhook routine | Register its peer, create the routine in Grok Bot, and configure the private target below. | The routine uses its own existing MCP connection to list/read its inbox; an HTTP 200 alone does not prove it ran or read the message. |
| Client with no supported callback | Register a peer and call `list_peer_messages`/`get_peer_message`. | Manual reads remain available; registration alone cannot wake a chat. |

MCP Events subscriptions expire: one day by default, or seven days with `ttlMs: null`. Maintain renewal before `expiresAt`; preserve unrelated routes and subscription IDs. The MCP callback path uses verified challenges and Standard Webhooks signatures with bounded retries. The separate official Webhook path below uses a bearer token and one durable attempt per new message, without an MCP challenge or automatic retry.

For Grok Bot, add this fragment to the **private** `config.json` only after the exact peer/generation is active. The current adapter supports at most one target, and that peer must have no active MCP Events callback:

```json
{
  "sharedOwner": true,
  "peerWakeTargets": [
    {
      "owner": "local-owner:shared",
      "peerId": "grok-bot",
      "generation": 1,
      "routineId": "mcp-mailbox",
      "credentialFile": "/Users/you/.local/share/local-agents-mcp/grok-wake/privateSecret.json"
    }
  ]
}
```

Create `credentialFile` outside the repository, owned by the gateway’s OS user with mode `0600` (regular file, no symlink). Its exact schema is below; replace placeholders privately with the official routine URL and bearer token, never commit them:

```json
{"url":"https://webhook.example.com/your-routine","token":"REPLACE_WITH_PRIVATE_BEARER_TOKEN"}
```

The URL must pass public HTTPS destination checks. The gateway sends only `eventId`, `messageId`, `peerId`, and `generation`; no message body or credentials are included in the payload. HTTP 200 records `webhook_accepted`; lost responses or interrupted claims remain `unknown` and are not retried. Binding activation starts from a saved watermark, so old mail is read manually rather than replayed into a routine. Stopped, revoked or changed peer generations disable the old binding; inspect the binding before reconfiguration.

Give the routine an explicit policy to read and report its own mail. Message text is data, not new user authorization; waking a client does not authorize it to execute the body, automatically reply or ACK. Confirm a test message’s exact ID and text in the recipient’s actual result before relying on automatic wake.

### Peer mailbox workflow

Peers are logical identities in one authenticated owner's directory shared across configured hosts. Each client registers a stable `peerId` once. With shared access enabled, other authenticated clients can discover it and send mail. Notification delivery follows the configured native, MCP Events, or private Webhook path; clients without a notification path check mail manually. The OAuth owner scopes the directory, but a peer ID and sender label are still claimed identity, not proof that a message came from a particular conversation. Treat message text as peer-authored data, never as new user authorization. The directory retains stopped identities and accepts up to 512 cumulative peer IDs per owner.

```json
{"peerId":"chat-main","kind":"chat","displayName":"Main chat"}
{"peerId":"dot","kind":"dot","displayName":"Coordinator"}
```

Each participant calls `register_peer` with its own `peerId` and `kind` (`chat`, `dot`, or `local`); the two objects above are separate registration calls. `displayName` is optional. For a `local` peer, also pass `hostId` and `agentId`. This only binds an agent that the same owner already has submitted on that host; registration does not create or start an agent. A native agent can use the fixed `peer-agent` CLI with its existing capability and Unix socket to call the peer tools. The CLI is a narrow local transport for those tools, not a full MCP transport, and it does not contain an OAuth key.

Use these seven tools with their exact arguments:

| Tool | Required arguments | Optional arguments |
| --- | --- | --- |
| `register_peer` | `peerId`, `kind` | `displayName`; `hostId` and `agentId` are required for `kind: "local"` and omitted otherwise |
| `list_peers` | — | `peerId` (filter to one identity) |
| `unregister_peer` | `peerId` | — |
| `send_peer_message` | `messageId`, `fromPeerId`, `toPeerId`, `text` | `inReplyTo` |
| `get_peer_message` | `messageId` | — |
| `list_peer_messages` | `peerId` | `includeProcessed` (default `false`), `limit` (1–100; default 50) |
| `ack_peer_message` | `messageId`, `peerId` | — |

Every new message needs a caller-generated UUID as `messageId`. Message text must contain 1–8,192 characters. Check the recipient's inbox with `list_peer_messages`; by default it returns received, unprocessed messages only. Each entry contains compact metadata, a `summary` of at most the first 200 text characters, and `textLength`; it omits the full text and delivery details so a long message cannot overwhelm the native CLI response. Use `get_peer_message` with that entry's exact `messageId` to read the full text when needed. Set `includeProcessed: true` to inspect processed history. Listing or reading leaves processing state unchanged. Once the recipient has handled a message, it can call `ack_peer_message` with that message's ID and its own `peerId`. ACK marks that exact message processed; it does not send a reply, event, wake, or prove task success.

```json
{"messageId":"b0bd3f0e-08d7-4bf6-9764-58e8ef83f85a","fromPeerId":"chat-main","toPeerId":"dot","text":"Please review the draft."}
{"peerId":"dot"}
{"messageId":"a0ebd6ce-e25f-4e14-88de-12e2c6cf6277","fromPeerId":"dot","toPeerId":"chat-main","text":"I reviewed it; see the notes.","inReplyTo":"b0bd3f0e-08d7-4bf6-9764-58e8ef83f85a"}
```

A reply reverses the original sender and recipient and sets `inReplyTo` to the original message UUID. Each message can have at most one reply, and a conversation is limited to eight hops. If a send outcome is uncertain, call `get_peer_message` with the exact original `messageId`; an unknown result is not a reason to resend with a new ID.

For local agents, busy delivery is queued and submitted when the agent becomes idle. The fixed `peer-agent` CLI has a 15-second default network timeout. A native registration and inbox are limited to that owner and the agent's current peer generation. Check for mail when a task starts, at stage completion, and when the agent becomes idle. Do not create automatic acknowledgements or reply loops; act only within the authority already granted to that agent.


## Choose a host and follow a task

Start with `list_hosts`. Use a returned `hostId` when selecting a remote host, and keep it with that host's `workspaceId`, `agentId`, `requestId`, and `routeId`. Mac calls may omit `hostId` for compatibility. Host-routed result reads, waits, and follow-ups should carry the same explicit `hostId`. Peer mailbox send/read/ACK calls do not take it; local registration uses it to select the agent's host.

The usual flow is to discover projects and provider capabilities on the chosen host, select or create a workspace there, then dispatch with a stable `requestId`. A receipt confirms submission, not task completion. If a result is `unknown` or still `submitting`, inspect the original request and that host's timeline; do not resend it under a new ID until you know whether it ran. Review the actual artifact before accepting the work.

`wait_for_agent_result` uses the original `requestId` and exact `agentId`, with a total budget of 1–20 seconds. `idle`, a terminal observation, readable text, and task success are separate; `acceptancePassed` remains `null`. Timeouts can be reread and do not cancel or redispatch work. Timeline pages are bounded to 1 MiB; follow returned cursors and check gap/stale/reset indicators.

Workspace roots only scope which project paths the gateway will target. They do not restrict what an agent process can execute. Authorized clients can still read and control agents in those roots, including cancellation, runtime settings, and specific permission responses. Grant OAuth access only to clients you trust with that authority.

## Direct Workspace

Direct Workspace adds project-scoped file and command tools to this existing Node.js gateway, alongside the tools backed by each host's Paseo daemon. Its design is adapted from Codex Bridge Direct; this is not a Swift runtime integration or a claim of complete protocol compatibility. It uses the same `hostId` routing as the other tools, with omitted `hostId` continuing to mean Mac.

The ten tools are `list_direct_projects`; `list_direct_files`, `search_direct_files`, `read_direct_file`, `write_direct_file`, and `edit_direct_file`; plus `run_direct_command`, `read_direct_command`, `write_direct_command_input`, and `cancel_direct_command`. Direct projects are configured locally per host. For Mac, place `direct.projects` at the top level; for an SSH host, put `direct.projects` inside that host's entry:

```json
{
  "direct": {
    "projects": [
      {
        "id": "example",
        "name": "Example project",
        "path": "/Users/you/Projects/example",
        "read": true,
        "write": false,
        "commandMode": "disabled"
      }
    ]
  }
}
```

Project defaults are read enabled, write disabled, and commands disabled. Enable writes per project when useful. File writes require `expectedSha256`: use `null` only to create a new file; updates must provide the current full-file hash, and a mismatch is rejected so you can reread before editing. `edit_direct_file` also checks the file hash before replacing the requested text.

Commands can stay disabled, use `commandMode: "registered"` with owner-configured exact `argv` entries (for example, `{ "name": "test", "argv": ["npm", "test"] }`), or use `commandMode: "full"` for literal argument arrays. Commands run with the selected host's normal OS permissions. The project working directory and allowed roots scope the project files and working directory; they do not sandbox a command or limit it to that directory.

Command requests are durable and keyed by `requestId`: rereading a request returns its recorded state and does not run it again. Interactive stdin writes use a deduplicated `inputId`; output reads are bounded and paginated by cursor. If the gateway restarts while a process is active, its record may become `interrupted` or `unknown`; the gateway does not promise to resume that process. Direct Workspace availability is independent of Paseo daemon health.

Output-cache eviction is visible through `lostCount` and `truncated`. If the worker's control connection is lost or overwhelmed, the command outcome can become `unknown`; the original command and input IDs are retained without automatic replay.

## Direct binary files

Direct binary transfers move file bytes between a project and the gateway without putting them into model text or base64, or routing them through Drive or Git. Local and SSH/WSL transfers use the fixed streaming path. Every call selects a `hostId`; export and import also name a `projectId`. Export uses the project's existing read permission, and import its write permission.

| Tool | Use |
| --- | --- |
| `export_direct_file` | Pass `hostId`, `projectId`, `path`, and a stable `requestId`. The gateway creates an immutable snapshot and returns byte count, SHA-256, and a single-file HTTPS link on its existing MCP domain. Files are limited to 256 MiB; live snapshots share a 512 MiB cap and expire after 10 minutes. |
| `import_direct_file` | Pass `hostId`, `projectId`, destination `path`, `expectedSha256`, and the caller-authorized file input. New files use `expectedSha256: null`; overwrites require the destination's current hash. The gateway downloads to a private spool and atomically writes the file on the selected host. |
| `get_direct_transfer` | Read the recorded result using the original `hostId` and `requestId`. Known completed/failed receipts have a 24-hour recovery window; do not reuse their keys for new work. Unknown/interrupted tombstones remain, including across restart, and are never automatically retried; the bounded receipt store rejects new transfers when full. |

For ChatGPT file input, `import_direct_file` accepts the documented `_meta["openai/fileParams"]` file object: `download_url` and `file_id` are required, while `mime_type` and `file_name` are optional. See [OpenAI's file input reference](https://developers.openai.com/plugins/reference). The gateway fetches only public HTTPS URLs.

An export link is a short-lived bearer capability for that one file: anyone who obtains it can download the snapshot until it expires. Do not publish or log it. Revoking the OAuth owner also revokes that owner's active download tickets. The HTTP download itself does not re-authenticate or prove the identity of the OAuth client that received the link. After a gateway restart, old download tickets are invalid and pending transfer receipts become `interrupted`; use the original `requestId` to inspect the recorded state.

**A returned `resource_link` or URL does not prove the receiving client downloaded the file.** Delivery is complete only after the recipient actually downloads and saves the bytes, checks the reported byte count and SHA-256, and loads the file where it will be used. Some cloud clients may not be able to fetch the HTTPS link directly; in that environment this path has a materialization gap. Do not substitute Drive or Git and describe it as the same native transfer.

## Events and agent messages

The legacy tools transport and the `2026-07-28` MCP Events adapter share `/mcp`. For an Events-capable client, subscribe to `agent.attention` with explicit `hostId`, `workspaceId`, and a stable `routeId` unique to that chat, plus its HTTPS callback and signing secret. Confirm the route with `list_notification_routes`, then bind it to dispatches. Existing requests can be watched with their original request ID and an explicit route; this does not create an agent, send a prompt, or rebind another route. A subscription, route binding, `notifyOnFinish`, or successful callback delivery report does not prove that a client woke up or that its task succeeded. Without Events support, read or wait for results directly.

For remote tasks, the fixed message CLI runs on the remote host and reaches that host's dedicated channel on the Mac gateway through a reverse SSH Unix-socket forward. The Mac gateway centrally persists these messages; this does not create a public inbound message service. Keep each host's receipts, routes, and callback state distinct. When a host is unavailable, its data cannot be recovered by silently falling back to Mac; an uncertain request must be inspected on its original host rather than resubmitted elsewhere.

In 0.6.0, validation covered registration, A-to-B delivery, B's linked reply, and both peers reading and ACKing between two new ChatGPT peers, queued delivery to a busy Mac native agent when it became idle, and a ChatGPT → WSL native agent → ChatGPT reply/ACK flow. The cumulative 1,024-message history rejection was removed: existing history and duplicate protection remain, and sending, reading, ACKing, and retrying the original ID were exercised with a real 1,025th message. These checks cover the listed workflows; they do not qualify every host/client setup or deployment configuration. A deployed shared-domain exchange also exercised Grok Bot → dot via MCP Events and dot → Grok Bot via the official Webhook routine, with recipients reading the exact message IDs and text. This single exchange does not establish long-term delivery reliability or future subscription renewal.

MCP Events callbacks require HTTPS, verified challenges, public DNS/IP destinations, and Standard Webhooks signatures. Delivery checks resolved addresses, rejects redirects and private/local destinations, and uses a durable outbox with up to five attempts for transient errors; delivery stops on HTTP 410. Subscriptions last one day by default (`ttlMs: null` selects seven days); refresh them before expiry. Cursor replay is not implemented (`cursor: null`); recover exact results through read tools. Unsubscribe when monitoring ends, preserving unrelated routes.

## Security and data

Read [SECURITY.md](SECURITY.md) before exposing a gateway. This is a single-owner authority domain, not a multi-tenant service. Protect the owner password, OAuth state, callback URLs/secrets, receipts, agent capabilities, messages, and task results. State is private local data, not encrypted storage; protect backups and access by other processes running as the same OS user.

The Mac and remote `allowedRoots` checks resolve canonical paths and reject out-of-scope targets and symlink escapes. They are gateway checks, not OS sandboxes. SSH access follows the operator's existing OpenSSH authentication; do not expose arbitrary URLs or SSH commands through public MCP tools. The gateway does not silently install or start remote services, configure providers, or transfer credentials. OAuth clients are dynamically registered; `local-agents` is the required scope, not a fixed client ID. The MCP resource URL is the configured public origin plus `/mcp`.

The public source snapshot excludes production configuration, runtime databases, captured sessions, private callback URLs, and operational history. Never use those items as public examples.

## Development and attribution

```sh
npm ci --ignore-scripts
npm run check
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

The scoped override pins `@waishnav/devspace`'s SQLite dependency to `better-sqlite3` 13.0.3 and its Node-API prebuilds, avoiding an unnecessary source rebuild on supported platforms; see the [official 13.0.0 release notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0). CI runs syntax checks and the repository's behavior/security tests on Node.js 22.19 and 24. A green host availability result confirms that a configured Paseo daemon responds; it does not certify every task, message, or event flow. Verify the client and workflows you rely on in your deployment environment.

Original project code and documentation, except the Apache-marked Direct modules and tests, are licensed under [MIT](LICENSE), Copyright (c) 2026 xixilys. The modified Node modules in `src/direct-*` and Direct tests with Apache SPDX headers are adapted from Codex Bridge Direct at [revision `f881877`](https://github.com/Fanch-hui/codex-bridge/tree/f881877183bb1f5d355124caf6b86cb7f2323e53) and are licensed under Apache-2.0; see [NOTICE](NOTICE) and [third_party/codex-bridge-LICENSE](third_party/codex-bridge-LICENSE). The Paseo schema fixture is also Apache-2.0; its license is at [third_party/paseo-LICENSE](third_party/paseo-LICENSE). Dependencies and Paseo binaries are not bundled and retain their own licenses and terms.
