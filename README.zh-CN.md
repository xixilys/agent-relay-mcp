<p align="center">
  <img src="docs/assets/banner.svg?v=agent-relay-20261012" alt="Agent Relay MCP — 一个网关，多个 Paseo 主机" width="100%">
</p>

<p align="center">
  简体中文 · <a href="README.md">English</a>
</p>

<p align="center">
  <a href="NOTICE"><img alt="MIT and Apache-2.0 licenses" src="https://img.shields.io/badge/licenses-MIT%20%2B%20Apache--2.0-14b8a6.svg"></a>
  <a href="https://github.com/xixilys/agent-relay-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xixilys/agent-relay-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/Node.js-22.19%E2%80%9326-2563eb.svg">
</p>

**Agent Relay MCP 让 dot、ChatGPT、Grok Bot 和原生 agent 等可信客户端，通过一个受 OAuth 保护的自托管端点，在 Mac 和 SSH 可达的 Linux/WSL 主机上调度 Paseo agent、互发 peer 邮件，并使用 Direct 文件、命令和二进制传输。**可选择跨客户端共享权限，并按接收方能力配置自动唤醒。

这是供单一可信所有者使用的自托管网关。agent 在所选主机上运行，使用该主机安装的 Paseo 和运行时权限。网关不提供模型账号、托管服务或操作系统沙箱。

![经过认证的 MCP 请求由网关路由到彼此独立管理的 Mac 和 SSH 主机。](docs/assets/host-topology.svg?v=agent-relay-20261012)

## 功能

- **单一端点，明确选择主机。**`list_hosts` 返回每台主机的 `hostId`、名称和可用状态。按主机路由的工具接受 `hostId`；省略时保持兼容旧调用，默认使用 Mac。远程调用以及后续事件或回执读取都应显式传入 `hostId`。peer 邮箱的发信、读信和 ACK 使用账户级共享目录；注册本地 peer 时用 `hostId` 绑定 agent。
- **主机任务与历史隔离。**项目、workspace、agent、任务回执和主机回调都属于各自主机。网关不会跨机器猜测或查找 ID。Peer 身份和消息则共享同一认证 owner 的目录，可供已配置的各主机访问。
- **可信客户端共享权限。**设置 `sharedOwner: true` 后，已认证客户端共享 peer 邮箱、原 agent 任务以及 Direct 命令、文件和传输。OAuth 认证及每个客户端的 token 撤销仍然有效；省略此项或设为 `false` 则保持原先按 OAuth client 分隔的权限域。
- **按客户端能力通知收件人。**注册稳定 peer ID，发信、关联回复和 ACK。原生 agent 忙时排队、空闲后接收；支持 MCP Events 的客户端订阅 `peer.message`；Grok Bot 可配置官方 Webhook routine。没有对应回调能力的聊天手动查信。历史邮件不因累计封数门槛挡住新邮件。
- **沿用已有 Paseo。**网关连接 Mac 上的 Paseo 实例和显式配置的 SSH 主机。它不会继承 Paseo 桌面端的主机列表、远程安装 Paseo、启动其 daemon，也不会改动 Provider 或凭据。
- **远程消息回到 Mac 网关。**远端主机上的固定 CLI 通过 reverse SSH Unix-socket forward 连接到 Mac 上该主机专属的 channel。消息由 Mac 网关集中持久化，不会新增公网消息端点。

## 快速开始

下面是 0.6.0 多主机配置的结构示例。请将示例路径和主机值替换为你控制的实际值。Mac 主机默认存在；这里只列额外远端主机。

```sh
git clone https://github.com/xixilys/agent-relay-mcp.git
cd agent-relay-mcp
npm ci --ignore-scripts
cp config.example.json config.json
```

配置一个 OAuth 网关和需要使用的主机。Mac 的现有字段继续放在顶层；远端主机写入 `hosts`：

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

启动服务前，先在 Mac 的状态目录中创建私有 owner 密码文件。密码和状态目录应放在源码仓库之外。网关进程与本机 Paseo 应由同一个 Mac 用户运行。每台远端主机都必须已安装并运行 Paseo；SSH 身份须能通过你现有的 OpenSSH 认证配置访问它。远端 `allowedRoots` 会在远端解析规范路径后检查；这是路径策略，不是操作系统沙箱。请为 `remoteStateDir` 及其父目录选择能通过 bridge 私有目录检查的权限；已有目录不会被自动改成私有权限。

Mac 上的 Paseo observer helper 使用应用自带的 Electron runtime 和客户端。原有支持配置为 Paseo **0.10.3**，安装位置是 `/Applications/Paseo.app`；其他版本或路径仍需验证。网关要求 Node.js `>=22.19 <27`、npm 和 `better-sqlite3` **13.0.3**，该版本提供 Node-API 预构建二进制。`npm ci --ignore-scripts` 会继续禁用依赖 lifecycle scripts；支持预构建包的平台无需手动编译原生模块。未提供预构建包的平台或主动选择源码编译时，可能需要 C/C++ 工具链、Python 和官方 Node headers。

```sh
npm run check
npm test
npm start
```

每个配置端口和状态目录只运行一个网关。请在 `127.0.0.1:6768` 前配置 HTTPS reverse proxy，保留 authorization 和 MCP headers，并让兼容客户端连接 `https://<your-origin>/mcp`。TLS、代理限流、服务管理和客户端注册由运维者负责。Paseo 的 loopback 端点必须保持私有。仓库不会配置 tunnel 或修改防火墙规则。

OAuth client 通过动态注册生成。授权使用 `local-agents` scope、S256 PKCE 和准确的 MCP resource URL（`https://<your-origin>/mcp`）。Access token 有效期为一小时，refresh token 为 30 天。重定向允许 `chatgpt.com`、`chat.openai.com`、`www.cursor.com` 和 loopback 主机（`localhost`、`127.0.0.1`、`::1`）；其他客户端重定向主机需要有意修改源码。对外开放前，请在代理上为注册和授权端点设置速率限制。

<details>
<summary>创建 owner 密码文件</summary>

以下命令会创建权限受限的文件；如果文件已存在则不会覆盖：

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

## 共享权限与邮箱唤醒

新安装示例为单一用户的可信客户端开启 `sharedOwner: true`。所有已认证 OAuth client 使用 `local-owner:shared`，共享 peer 目录、原 agent 任务、Direct 命令、文件和传输回执。OAuth 校验、原生 agent capability、项目权限和已有任务授权仍有效；撤销一个客户端的 token 不会停掉其他客户端的共享资源。不设置此项时仍使用原来的 `local-owner:<clientId>` 权限域。

### 升级已有安装

先用现有服务管理方式停止网关，不要对运行中的状态目录迁移；先处理进行中的 Direct 命令、二进制传输或原生 peer 投递。另行保存原私有配置和 wake 绑定，再在仓库中执行，替换为实际状态目录及一个尚不存在的备份目录：

```sh
python3 scripts/migrate-shared-owner.py \
  --state-dir /Users/you/.local/share/local-agents-mcp \
  --backup-dir /Users/you/.local/share/agent-relay-migration-backup \
  --apply
```

迁移成功后，在 `config.json` 中设置 `sharedOwner: true`，将私有 `peerWakeTargets` 的 `owner` 改为 `local-owner:shared`，再启动一个网关。各客户端检查 `list_hosts`、`list_peers` 和原回执。迁移保留旧 subscription ID、消息原文和处理状态、历史回执、原 agent 撤权记录及 Webhook 水位/claim；未知操作不重发。活跃/已绑定 peer 重名或消息 ID 冲突会拒绝迁移；重名且已停止、无绑定的 peer 可加历史后缀。脚本不修改 OAuth 凭据、不启动 agent。

备份包含私有状态，须放在 Git 之外。迁移失败时保持网关停止，恢复全部备份数据库/回执文件和原配置后再启动。共享模式已有新数据时，直接恢复旧备份可能丢失它们；仅把选项改回 `false` 不会将共享历史迁回各客户端。

### 选择接收方的通知方式

| 接收方能力 | 配置 | 实际验收 |
| --- | --- | --- |
| 原生 Paseo agent | 用已拥有的 `hostId`、`agentId` 注册 `kind: "local"`。 | 忙时排队、空闲后接收；检查原消息和 agent 实际结果。 |
| 支持 MCP Events 的客户端，包括兼容的 dot 会话 | 注册 peer，由接收方会话调用 `events/subscribe` 订阅 `peer.message`，使用实际 ID/generation 替换 `arguments: {"peerId":"dot","generation":1}`，回调和签名密钥由平台提供。 | 保留无关 `agent.attention` 订阅；确认无需新用户提示就读取原件。 |
| 提供官方 Webhook routine 的 Grok Bot | 注册 peer，在 Grok Bot 创建 routine，按下例配置私有 target。 | routine 用自身已有 MCP 连接读邮箱；HTTP 200 不证明已运行或读信。 |
| 没有受支持回调的客户端 | 注册 peer，调用 `list_peer_messages`/`get_peer_message`。 | 手动查信可用；仅注册身份不能唤醒聊天。 |

MCP Events 订阅会到期：默认一天，`ttlMs: null` 为七天。应在 `expiresAt` 前维护续订，并保留无关路由和 subscription ID。MCP callback 使用 challenge 验证、Standard Webhooks 签名和有限重试；下述独立官方 Webhook 使用 bearer token，每封新信只做一次持久投递尝试，不运行 MCP challenge，不自动重试。

Grok Bot 的准确 peer/generation 已注册且 active 后，才将以下片段加入**私有** `config.json`。当前 adapter 最多支持一个 target，且该 peer 不能同时绑定有效的 MCP Events callback：

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

在仓库外创建 `credentialFile`，由网关运行用户拥有，权限为 `0600`，必须是普通文件而非符号链接。准确 schema 如下；只在私有文件中替换成官方 routine URL 和 bearer token，不要提交凭据：

```json
{"url":"https://webhook.example.com/your-routine","token":"REPLACE_WITH_PRIVATE_BEARER_TOKEN"}
```

URL 必须通过公网 HTTPS 目标检查。网关只发送 `eventId`、`messageId`、`peerId`、`generation` 元数据，不在 payload 中发送正文或凭据。HTTP 200 记录 `webhook_accepted`；响应丢失或中断 claim 保留 `unknown`，不重试。首次绑定从保存的水位开始，旧信应手动读取，不回放到 routine。peer 停止、撤权或 generation 变化会禁用旧绑定；重新配置前先检查绑定状态。

给 routine 明确的查收、报告自身邮件策略。正文是数据，唤醒不自动授权执行正文、回复或 ACK。依靠自动唤醒前，应在接收方实际结果中确认测试消息的准确 ID 和原文。

### peer 邮箱使用流程

Peer 是认证 owner 目录内的逻辑身份，可跨已配置主机使用。每个客户端注册稳定的 `peerId`；启用共享后，其他已认证客户端即可查询并发信。通知按配置走原生 agent、MCP Events 或私有 Webhook；没有通知入口的聊天手动查信。peer ID 和发送者标签仍是自报身份，不证明消息来自特定会话。消息正文是 peer 提供的数据，不是新的用户授权。目录保留已停止身份，每个 owner 最多累计注册 512 个不同 `peerId`。

```json
{"peerId":"chat-main","kind":"chat","displayName":"主聊天"}
{"peerId":"dot","kind":"dot","displayName":"协调者"}
```

每个参与者用自己的身份调用 `register_peer`，必填 `peerId` 和 `kind`（`chat`、`dot` 或 `local`）；上面的两个对象分别用于两次注册调用。`displayName` 可选。`kind: "local"` 时还要传 `hostId` 和 `agentId`。这只会绑定同一 owner 在该主机上已经提交的 agent，不会创建或启动 agent。本地 agent 可用固定的 `peer-agent` CLI，通过已有 capability 和 Unix socket 调用这些 peer 工具。该 CLI 是面向这些工具的窄范围本地传输，不是完整 MCP transport，也不包含 OAuth key。

七个工具的参数如下：

| 工具 | 必填参数 | 可选参数 |
| --- | --- | --- |
| `register_peer` | `peerId`、`kind` | `displayName`；`hostId` 和 `agentId` 在 `kind: "local"` 时必填，其他类型省略 |
| `list_peers` | — | `peerId`（筛选某个身份） |
| `unregister_peer` | `peerId` | — |
| `send_peer_message` | `messageId`、`fromPeerId`、`toPeerId`、`text` | `inReplyTo` |
| `get_peer_message` | `messageId` | — |
| `list_peer_messages` | `peerId` | `includeProcessed`（默认 `false`）、`limit`（1–100，默认 50） |
| `ack_peer_message` | `messageId`、`peerId` | — |

每条新消息都要由调用方生成 UUID 作为 `messageId`。消息文本长度须为 1–8,192 个字符。用 `list_peer_messages` 查收目标 peer 的 inbox；默认只列出已收到、尚未处理的消息。每条结果只包含精简 metadata、最多前 200 个文本字符的 `summary` 和 `textLength`，不含全文及投递详情，避免长消息撑大 native CLI 响应。需要阅读全文时，使用结果中的原始 `messageId` 调用 `get_peer_message`。设置 `includeProcessed: true` 可查看已处理历史。列出或读取消息都不会改变处理状态。接收方处理完消息后，用该消息 ID 和自己的 `peerId` 调用 `ack_peer_message`。ACK 只把这条消息标记为已处理；它不会发送回复、事件或唤醒，也不能证明任务成功。

```json
{"messageId":"b0bd3f0e-08d7-4bf6-9764-58e8ef83f85a","fromPeerId":"chat-main","toPeerId":"dot","text":"请审阅这份草稿。"}
{"peerId":"dot"}
{"messageId":"a0ebd6ce-e25f-4e14-88de-12e2c6cf6277","fromPeerId":"dot","toPeerId":"chat-main","text":"我已审阅，详见批注。","inReplyTo":"b0bd3f0e-08d7-4bf6-9764-58e8ef83f85a"}
```

回复时要反转原消息的发送方与接收方，并把原消息 UUID 填入 `inReplyTo`。每条消息最多允许一条回复；一个会话最多八跳。如果发送结果不确定，使用原始 `messageId` 调用 `get_peer_message` 查询；查不到时也不要换一个 ID 重发。

本地 agent 忙时，投递会排队，等 agent 空闲后提交。固定的 `peer-agent` CLI 默认网络超时为 15 秒。native 注册和 inbox 仅限该 owner 及 agent 当前 peer generation。请在任务开始、阶段完成和 agent 空闲时查收消息。不要自动生成致谢或回复循环；收到的内容只能在该 agent 已有权限范围内处理。


## 选择主机并跟进任务

先调用 `list_hosts`。选择远端主机时使用返回的 `hostId`，并将它与该主机的 `workspaceId`、`agentId`、`requestId` 和 `routeId` 一起保存。为兼容旧调用，Mac 请求可以省略 `hostId`。按主机路由的结果读取、等待和后续跟进都应传入同一个 `hostId`。peer 邮箱的发信、读信和 ACK 不接受此参数；本地注册时用它选择 agent 所在主机。

常规流程是在选定主机上发现项目与 Provider 能力，选择或创建该主机的 workspace，再使用稳定的 `requestId` 派发。回执只能确认已提交，不能证明任务已完成。如果结果为 `unknown` 或仍处于 `submitting`，应检查原始请求及该主机的 timeline；确认原操作是否运行前，不要换一个 ID 重发。验收前要检查实际产物。

`wait_for_agent_result` 使用原始 `requestId` 和准确的 `agentId`，总等待预算为 1–20 秒。`idle`、终态观察、可读取的文本和任务成功彼此不同；`acceptancePassed` 仍为 `null`。超时后可重新读取，不会取消或重新派发任务。Timeline 页面最多 1 MiB；请按返回的 cursor 继续读取，并检查 gap/stale/reset 标记。

workspace 根目录只限定网关可以选择的项目路径，不会限制 agent 进程可执行的操作。获授权的客户端仍可读取和控制这些根目录中的 agent，包括取消任务、调整 runtime 设置和响应特定权限请求。只授权给你信任其拥有这些权限的 OAuth 客户端。

## Direct Workspace

Direct Workspace 在现有 Node.js 网关中增加按项目授权的文件与命令工具，与各主机 Paseo daemon 提供的工具并列。设计借鉴并适配了 Codex Bridge Direct；它不是 Swift runtime 集成，也不代表完整协议兼容。它沿用相同的 `hostId` 路由规则；省略 `hostId` 时仍指 Mac。

十个工具分别是：`list_direct_projects`；`list_direct_files`、`search_direct_files`、`read_direct_file`、`write_direct_file`、`edit_direct_file`；以及 `run_direct_command`、`read_direct_command`、`write_direct_command_input`、`cancel_direct_command`。Direct project 在本地按主机配置。Mac 的 `direct.projects` 放在顶层；SSH 主机的 `direct.projects` 放在对应 host 条目内：

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

默认允许读取、关闭写入和命令。需要时可对单个 project 启用写入。文件写入必须提供 `expectedSha256`：仅新建文件时使用 `null`；更新文件须提供当前整文件 hash，若内容已变化则拒绝写入，你可以先重新读取再编辑。`edit_direct_file` 也会在替换指定文本前核对整文件 hash。

命令可以保持禁用；也可以设置 `commandMode: "registered"` 并由所有者配置精确的 `argv` 条目（例如 `{ "name": "test", "argv": ["npm", "test"] }`）；或显式使用 `commandMode: "full"` 传入字面参数数组。命令使用所选主机的正常操作系统权限运行。项目工作目录和 allowed roots 用于限定项目文件与工作目录，不会沙箱化命令，也不会限制命令只能访问该目录。

命令请求以 `requestId` 持久记录：再次读取会返回原记录，不会重新运行。交互式 stdin 写入使用可去重的 `inputId`；命令输出有界，并通过 cursor 分页。若网关在进程运行期间重启，请求记录可能变为 `interrupted` 或 `unknown`；网关不承诺恢复该进程。Direct Workspace 的可用性独立于 Paseo daemon 健康状态。

输出缓存淘汰会通过 `lostCount` 和 `truncated` 显示。若工作进程的控制连接丢失或拥塞，命令结果可能变为 `unknown`；原命令和输入 ID 仍保留，不会自动重放。

## Direct binary files

Direct binary transfer 在项目与网关之间传输原始文件字节，不把内容放进模型文本或 base64，也不经由 Drive 或 Git。本机与 SSH/WSL 使用固定的流式传输路径。每次调用都选择 `hostId`；导出和导入还会指定 `projectId`。导出沿用项目已有的读取权限，导入沿用写入权限。

| 工具 | 用途 |
| --- | --- |
| `export_direct_file` | 传入 `hostId`、`projectId`、`path` 和稳定的 `requestId`。网关生成不可变快照，并返回字节数、SHA-256，以及现有 MCP 域名下的单文件 HTTPS 链接。单文件上限 256 MiB；有效快照总量上限 512 MiB，10 分钟后过期。 |
| `import_direct_file` | 传入 `hostId`、`projectId`、目标 `path`、`expectedSha256` 和由调用者授权的文件输入。新建文件使用 `expectedSha256: null`；覆盖已有文件须提供目标当前 hash。网关先下载到私有 spool，再在选定主机上原子写入文件。 |
| `get_direct_transfer` | 使用原始 `hostId` 和 `requestId` 读取已记录结果。已完成或确定失败的回执可恢复 24 小时，不要复用它们的 ID 开始新工作。未知或中断记录会保留，重启后也不自动重做；有界回执存储满时拒绝新传输。 |

ChatGPT 文件输入遵循官方 `_meta["openai/fileParams"]` 格式：`download_url` 和 `file_id` 必填，`mime_type` 和 `file_name` 可选。详见 [OpenAI 文件输入参考](https://developers.openai.com/plugins/reference)。网关只从公网 HTTPS URL 拉取文件。

导出链接是短期 bearer capability，只指向一个文件：在过期前，任何拿到链接的人都能下载快照。不要公开或写入日志。撤销 OAuth owner 时，也会撤销该 owner 尚有效的下载 ticket。HTTP 下载本身不会重新验证或证明收到链接的 OAuth client 身份。网关重启后，旧下载 ticket 会失效，未完成的传输回执会变为 `interrupted`；用原始 `requestId` 查询记录状态。

**返回 `resource_link` 或 URL 不代表接收端已经下载文件。**只有接收端真正下载并保存字节、核对返回的字节数与 SHA-256，并在使用位置加载文件后，才算交付完成。有些云端客户端可能无法直接通过 HTTPS 获取该链接；此时这条路径存在实际落盘能力缺口。不要悄悄改用 Drive 或 Git 后仍称作同一种原生传输。

## 事件与 agent 消息

旧 tools transport 和 `2026-07-28` MCP Events adapter 共用 `/mcp`。支持 Events 的客户端订阅 `agent.attention` 时，应显式传入 `hostId`、`workspaceId`，并为每个聊天使用稳定且唯一的 `routeId`，同时提供 HTTPS callback 和签名密钥。通过 `list_notification_routes` 确认路由后，再将它绑定到任务。已有请求可以用原始 request ID 和显式 route 添加 watch；这不会创建 agent、发送 prompt 或改绑到其他 route。订阅、route 绑定、`notifyOnFinish` 或成功的回调投递记录，都不能证明客户端已被唤醒或任务已成功。客户端不支持 Events 时，可直接读取或等待结果。

远程任务使用固定消息 CLI；CLI 在远端主机运行，通过 reverse SSH Unix-socket forward 连接到 Mac 网关上该主机专属的 channel。消息由 Mac 网关集中持久化；此机制不会创建公网入站消息服务。各主机的回执、路由和回调状态仍彼此独立。主机不可用时，不能静默回退到 Mac 获取其数据；状态不确定的请求必须在原主机检查，不应换到其他机器重新提交。

0.6.0 已验证以下工作流：两个全新 ChatGPT peer 注册后完成 A 发给 B、B 关联回复，以及双方读取并 ACK；Mac 原生 agent 忙碌时消息排队，并在 agent 空闲后提交；以及 ChatGPT → WSL 原生 agent → ChatGPT 的回复与 ACK。已移除累计 1,024 条消息后拒收新消息的限制，同时保留历史和重复消息保护；已用真实第 1,025 条消息验证发送、读取、ACK，以及使用原 ID 重试。这些检查覆盖所列流程，不代表所有主机、客户端组合或部署配置都已验收。 已部署的共享模式也实测了 Grok Bot → dot 的 MCP Events 通知，以及 dot → Grok Bot 的官方 Webhook routine，接收方实际读到了准确的消息 ID 和原文。这次互发不证明长期投递稳定性或未来订阅续订可靠性。

MCP Events 回调要求 HTTPS、通过验证的 challenge、公网 DNS/IP 目标和 Standard Webhooks 签名。投递前会检查解析出的地址、拒绝重定向和私有/本地目标，并使用持久化 outbox；遇到临时错误最多尝试五次，HTTP 410 后停止投递。订阅默认持续一天（`ttlMs: null` 表示七天）；过期前应刷新。当前不支持 cursor replay（`cursor: null`）；请通过读取工具恢复准确结果。监控结束后取消订阅，同时保留其他无关路由。

## 安全与数据

对外开放网关前请阅读 [SECURITY.md](SECURITY.md)。这是单一所有者的权限域，不是多租户服务。请保护 owner 密码、OAuth 状态、回调 URL/密钥、回执、agent capability、消息和任务结果。状态数据保存在本地但未加密；也要保护备份，以及同一操作系统用户下其他进程的访问权限。

Mac 和远端 `allowedRoots` 检查都会解析规范路径，并拒绝越界目标和符号链接逃逸。这些是网关检查，不是操作系统沙箱。SSH 访问遵循操作者现有的 OpenSSH 认证配置；不要通过公开 MCP 工具接受任意 URL 或 SSH 命令。网关不会静默安装或启动远程服务，也不会配置 Provider 或传递凭据。OAuth client 通过动态注册生成；`local-agents` 是必需的 scope，不是固定 client ID。MCP resource URL 是配置的公开 origin 加 `/mcp`。

公开源码快照不包含生产配置、运行时数据库、捕获的会话、私有回调 URL 或运维历史。不要将这些内容用作公开示例。

## 开发与归属

```sh
npm ci --ignore-scripts
npm run check
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

项目使用 scoped override，将 `@waishnav/devspace` 下的 SQLite 依赖固定到 `better-sqlite3` 13.0.3 及其 Node-API 预构建包，支持平台无需额外源码编译；详见 [13.0.0 官方发布说明](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)。CI 使用 Node.js 22.19 和 24 运行语法检查及仓库中的行为/安全测试。主机状态显示可用，表示配置的 Paseo daemon 有响应；这不能证明所有任务、消息或事件流程都正常。请在自己的部署环境中验证实际使用的客户端和工作流。

除带 Apache 标记的 Direct 模块与测试外，项目原始代码和文档采用 [MIT](LICENSE) 许可，版权归 xixilys 所有，年份为 2026。`src/direct-*` 中经过修改的 Node 模块及带 Apache SPDX 标记的 Direct 测试源自 Codex Bridge Direct 的 [revision `f881877`](https://github.com/Fanch-hui/codex-bridge/tree/f881877183bb1f5d355124caf6b86cb7f2323e53)，采用 Apache-2.0 许可；详见 [NOTICE](NOTICE) 和 [third_party/codex-bridge-LICENSE](third_party/codex-bridge-LICENSE)。Paseo schema fixture 也采用 Apache-2.0，许可文本见 [third_party/paseo-LICENSE](third_party/paseo-LICENSE)。此处不附带依赖或 Paseo 二进制文件；它们各自遵循其许可与使用条款。
