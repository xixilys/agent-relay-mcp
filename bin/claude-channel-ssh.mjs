#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClaudeChannel } from './claude-channel.mjs';

const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino;
const fail = reason => Object.assign(Error(reason),{ reason });
const reasons = new Set(['starting','ssh_started','ssh_disconnected','ssh_reconnecting','ssh_auth_failed',
  'ssh_host_key_failed','ssh_configuration_failed','ssh_spawn_failed','unsafe_local_path','unsafe_socket','invalid_socket_path','invalid_options',
  'startup_failed','stdin_eof','sdk_closed','signal_sigterm','signal_sigint','requested_close',
  'binding_inactive','consumer_conflict','notification_limit','notification_timeout','stopped']);
function diagnostic(reason,status) {
  const value = { event: 'claude_channel_ssh_lifecycle',at: new Date().toISOString(),
    reason: reasons.has(reason) ? reason : 'stopped' };
  if (Number.isInteger(status)) value.status = status;
  process.stderr.write(`${JSON.stringify(value)}\n`);
}
export function validateSSHOptions({ sshAlias,remoteSocketPath,stateDir }) {
  // Forward specifications have their own syntax even without a shell.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sshAlias ?? '') ||
      typeof remoteSocketPath !== 'string' || !isAbsolute(remoteSocketPath) ||
      !/^\/[A-Za-z0-9_./-]+$/.test(remoteSocketPath) ||
      remoteSocketPath.split('/').some(p => p === '.' || p === '..') ||
      typeof stateDir !== 'string' || !isAbsolute(stateDir) ||
      /[\s:\\]/.test(stateDir) || stateDir.split('/').some(p => p === '.' || p === '..')) throw fail('invalid_options');
}
async function privateDirectory(path,identity) {
  // Do not allow a symlink in the supplied path, including its ancestors.
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current,part);
    const info = await lstat(current);
    if (!info.isDirectory()) throw fail('unsafe_local_path');
  }
  const info = await lstat(path);
  if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
      (identity && !sameFile(info,identity))) throw fail('unsafe_local_path');
  return info;
}
function permanentSSHFailure(stderr) {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Offending .* key|host key .* changed/i.test(stderr)) return 'ssh_host_key_failed';
  if (/Permission denied|Authentication failed|Too many authentication failures|No more authentication methods/i.test(stderr)) return 'ssh_auth_failed';
  if (/Bad configuration option|Bad local forwarding specification|Could not resolve hostname|no matching (?:host key type|key exchange method|cipher).*found|Bad owner or permissions|Load key .* (?:invalid format|error in libcrypto)/i.test(stderr)) return 'ssh_configuration_failed';
}

export async function runClaudeChannelSSH({ sshAlias,remoteSocketPath,stateDir,input = process.stdin,output = process.stdout,spawnSSH = spawn }) {
  validateSSHOptions({ sshAlias,remoteSocketPath,stateDir });
  const parentIdentity = await privateDirectory(stateDir);
  const localDir = await mkdtemp(join(stateDir,'cc-'));
  const directoryIdentity = await privateDirectory(localDir);
  const socketPath = join(localDir,'s');
  let socketIdentity, child, retryTimer, monitor, stopping, runtime, attempts = 0;
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  async function checkLocal() {
    await privateDirectory(stateDir,parentIdentity);
    await privateDirectory(localDir,directoryIdentity);
    let info;
    try { info = await lstat(socketPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 ||
        (socketIdentity && !sameFile(info,socketIdentity))) throw fail('unsafe_local_path');
    socketIdentity ??= info;
    return info;
  }
  async function cleanup() {
    // Never recursively remove a directory or unlink an unrecognized file.
    try {
      await checkLocal();
      await privateDirectory(localDir,directoryIdentity);
      const info = await lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info && socketIdentity && sameFile(info,socketIdentity) && info.isSocket()) await unlink(socketPath);
      await rmdir(localDir);
    } catch { /* A changed or nonempty directory is deliberately preserved. */ }
  }
  function close(reason = 'requested_close',status) {
    if (stopping) return stopping;
    stopping = (async () => {
      diagnostic(reason,status);
      clearTimeout(retryTimer); clearInterval(monitor);
      const owned = child;
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        let safeToUnlink = false;
        try { safeToUnlink = Boolean(await checkLocal()); }
        catch { reason = 'unsafe_local_path'; diagnostic(reason); }
        // The child can exit while filesystem validation yields. Do not
        // wait for a close event that has already been emitted.
        if (owned.exitCode === null && owned.signalCode === null) await new Promise(resolve => {
          const killTimer = setTimeout(() => { owned.kill('SIGKILL'); },1500);
          owned.once('close',() => { clearTimeout(killTimer); resolve(); });
          // A graceful SSH exit may unlink its bound pathname. When that
          // pathname was replaced, prevent the child from deleting it.
          owned.kill(!safeToUnlink || ['unsafe_local_path','unsafe_socket','invalid_socket_path'].includes(reason) ? 'SIGKILL' : 'SIGTERM');
        });
      }
      try { await runtime?.close(reason,status); }
      catch { reason = 'startup_failed'; diagnostic(reason); }
      finally { await cleanup(); diagnostic('stopped'); finish({ reason,status }); }
    })();
    return stopping;
  }
  async function startSSH() {
    if (stopping) return;
    try { await checkLocal(); } catch { void close('unsafe_local_path'); return; }
    if (stopping) return;
    const args = ['-NT','-S','none','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12','-o','ExitOnForwardFailure=yes',
      '-o','StreamLocalBindUnlink=yes','-o','StreamLocalBindMask=0177',
      '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L',`${socketPath}:${remoteSocketPath}`,sshAlias];
    let owned;
    try { owned = spawnSSH('ssh',args,{ stdio: ['ignore','ignore','pipe'] }); }
    catch { void close('ssh_spawn_failed'); return; }
    child = owned; diagnostic('ssh_started');
    // SSH output can contain paths, keys or server text. Inspect a bounded
    // private buffer for fixed classifications, never forward it to stdio.
    let stderr = '',fatal;
    owned.stderr.on('data',chunk => {
      stderr = (stderr+chunk.toString('utf8')).slice(-16384);
      fatal ??= permanentSSHFailure(stderr);
      if (fatal) void close(fatal);
    });
    owned.once('error',() => { void close('ssh_spawn_failed'); });
    owned.once('close',async code => {
      if (child === owned) child = undefined;
      if (stopping) return;
      if (fatal) { void close(fatal); return; }
      try { await checkLocal(); } catch { void close('unsafe_local_path'); return; }
      try {
        if (socketIdentity) {
          const info = await lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (info && (!sameFile(info,socketIdentity) || !info.isSocket())) throw fail('unsafe_local_path');
          if (info) await unlink(socketPath);
        }
      } catch { void close('unsafe_local_path'); return; }
      // BindUnlink may replace only the socket created by this launcher.
      socketIdentity = undefined;
      diagnostic('ssh_disconnected',code);
      const delay = Math.min(30000,2000 * 2 ** Math.min(attempts++,4));
      diagnostic('ssh_reconnecting');
      retryTimer = setTimeout(() => { void startSSH(); },delay);
    });
  }
  try {
    if (Buffer.byteLength(socketPath) > 100) throw fail('invalid_options');
    diagnostic('starting');
    runtime = await runClaudeChannel({ socketPath,input,output });
    if (!runtime.closed || typeof runtime.closed.then !== 'function') throw fail('startup_failed');
    void runtime.closed.then(({ reason,status }) => close(reason,status));
    let checking = false;
    monitor = setInterval(() => {
      if (checking || stopping) return;
      checking = true;
      void checkLocal().then(() => { if (socketIdentity && child) attempts = 0; })
        .catch(() => close('unsafe_local_path')).finally(() => { checking = false; });
    },500);
    await startSSH();
    return { close,closed };
  } catch (error) {
    await close(error.reason ?? 'startup_failed');
    throw fail(error.reason ?? 'startup_failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--ssh-alias' || args[2] !== '--remote-socket' || args[4] !== '--state-dir') {
    process.stderr.write('Usage: claude-channel-ssh.mjs --ssh-alias mac --remote-socket /absolute/private/claude-channel.sock --state-dir /absolute/private/directory\n'); process.exitCode = 2;
  } else {
    const signals = new Map();
    let runtime,pendingSignal;
    for (const signal of ['SIGTERM','SIGINT']) {
      const handler = () => { pendingSignal = signal; void runtime?.close(signal === 'SIGTERM' ? 'signal_sigterm' : 'signal_sigint'); };
      signals.set(signal,handler); process.once(signal,handler);
    }
    runClaudeChannelSSH({ sshAlias: args[1],remoteSocketPath: args[3],stateDir: args[5] }).then(value => {
      runtime = value;
      if (pendingSignal) void runtime.close(pendingSignal === 'SIGTERM' ? 'signal_sigterm' : 'signal_sigint');
      return runtime.closed;
    }).then(({ reason }) => {
      if (['ssh_auth_failed','ssh_host_key_failed','ssh_configuration_failed','ssh_spawn_failed','unsafe_local_path','unsafe_socket','invalid_socket_path','startup_failed'].includes(reason)) process.exitCode = 1;
    }).catch(error => { diagnostic(error.reason ?? 'startup_failed'); process.exitCode = 1; })
      .finally(() => { for (const [signal,handler] of signals) process.removeListener(signal,handler); });
  }
}
