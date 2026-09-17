#!/usr/bin/env node
// Foreground source builds use the selected profile's identity, never its installed release.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { repository, profilePaths, loadProfile, isolatedEnvironment, stopNative, withProfileLock, atomicJson, readJson } from './profile-lib.mjs';

const help = `Mote foreground debug server (macOS/Linux, Node 24+)
  node scripts/dev-server.mjs [--pull] [--install] [--profile NAME] [--home PATH]

Stops this profile's managed server, optionally git pull --ff-only, installs changed
dependencies, builds the current checkout's libraries/server/web and stays attached.
Ctrl+C stops the server and its children. --install forces npm ci.
Uses existing native development profiles; prod and port 47832 are excluded.
Existing tunnel connections keep using the same port. Deployment selection is unchanged.`;

// Each command owns a process group, so interrupting npm also stops its build grandchildren.
export function startCommand(command, args, { cwd, env, signal, graceMs = 5000 } = {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  let stopping = false, deadline = 0;
  const alive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const send = signalName => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signalName); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let forceTimer;
  const stop = () => {
    if (stopping || !child.pid) return;
    stopping = true; deadline = Date.now() + graceMs;
    send('SIGTERM');
    forceTimer = setTimeout(() => send('SIGKILL'), graceMs);
  };
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
  });
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const done = exited.finally(async () => {
    try {
      // A failed parent can leave workers alive even without an explicit interrupt.
      if (alive()) {
        stop();
        while (alive() && Date.now() < deadline) await sleep(50);
        if (alive()) send('SIGKILL');
      }
    } finally {
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', stop);
    }
  });
  // A long-lived caller may be performing startup checks before awaiting completion.
  void done.catch(() => undefined);
  return { child, done, stop };
}

function buildEnvironment() {
  // Installation/build hooks must not inherit a profile's token, model keys or NODE_OPTIONS.
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'];
  return { ...Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), NODE_ENV: 'development' };
}

async function dependencyFingerprint(root) {
  const files = ['package.json', 'package-lock.json'];
  for (const folder of ['apps', 'packages']) {
    for (const item of await readdir(join(root, folder), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const path = join(folder, item.name, 'package.json');
      try { await stat(join(root, path)); files.push(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const hash = createHash('sha256').update(`${process.version}/${process.platform}/${process.arch}`);
  for (const path of files.sort()) hash.update(path).update(await readFile(join(root, path)));
  return hash.digest('hex');
}

async function prepareCheckout(root, options, signal) {
  const env = buildEnvironment();
  const run = async (command, args) => {
    const result = await startCommand(command, args, { cwd: root, env, signal }).done;
    signal.throwIfAborted();
    if (result.code !== 0) throw Error(`${command} ${args.join(' ')} failed; no server was started`);
  };
  if (options.pull) { console.info('[dev] Pulling current branch (--ff-only)…'); await run('git', ['pull', '--ff-only']); }
  const fingerprint = await dependencyFingerprint(root), stampFile = join(root, 'node_modules', '.mote-dev-dependencies.json');
  const stamp = await readJson(stampFile, null);
  const installedLock = async () => {
    try { return createHash('sha256').update(await readFile(join(root, 'node_modules', '.package-lock.json'))).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  if (options.install || stamp?.fingerprint !== fingerprint || !stamp?.installedLock || stamp.installedLock !== await installedLock()) {
    console.info('[dev] Installing dependencies…');
    await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
    await atomicJson(stampFile, { fingerprint, installedLock: await installedLock() });
  } else console.info('[dev] Dependencies unchanged; reusing node_modules.');
  console.info('[dev] Building libraries, server and web from this checkout…');
  await run('npm', ['run', 'build:libs']);
  await run('npm', ['run', 'build', '-w', '@mote/server', '-w', '@mote/web']);
}

async function assertFreePort(p) {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once('error', () => reject(Error(`Port ${p.port} belongs to an unmanaged process. Stop its terminal with Ctrl+C, then retry.`)));
    server.listen(p.port, p.env.MOTE_HOST || '127.0.0.1', () => server.close(done));
  });
}

export async function runDevServer(options = {}, root = repository) {
  if (process.platform === 'win32' || Number(process.versions.node.split('.')[0]) < 24) throw Error('Use macOS/Linux with Node.js 24 or newer');
  const p = await loadProfile(profilePaths(options.profile ?? 'dev', options.home));
  if (p.profile === 'prod' || p.port === 47832 || p.meta.runtime !== 'native') throw Error('dev-server requires an existing native development profile, not prod');
  const controller = new AbortController(), { signal } = controller;
  const interrupt = () => { if (!signal.aborted) console.info('\n[dev] Stopping…'); controller.abort(); };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, interrupt);
  let server, marker;
  try {
    await withProfileLock(p, async () => {
      console.info(`[dev] Stopping the previous managed ${p.profile} server…`);
      await stopNative(p);
      signal.throwIfAborted();
      await assertFreePort(p);
      await prepareCheckout(root, options, signal);
      signal.throwIfAborted();
      await assertFreePort(p);
      const version = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8')).version;
      marker = randomUUID();
      server = startCommand(process.execPath, [join(root, 'apps/server/dist/index.js'), `--mote-instance=${marker}`], {
        cwd: root, env: isolatedEnvironment(p), signal, graceMs: 20000,
      });
      // Register before health checks: stop/status work on this source run too.
      await atomicJson(p.processFile, { pid: server.child.pid, marker, envFile: p.envFile, release: root, startedAt: new Date().toISOString() });
      const deadline = Date.now() + 30000;
      while (true) {
        signal.throwIfAborted();
        if (server.child.exitCode !== null || server.child.signalCode !== null) throw Error('Server exited during startup; see the output above');
        try {
          const response = await fetch(p.url + '/api/status', { headers: { Authorization: `Bearer ${p.env.MOTE_TOKEN}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
          await response.body?.cancel();
          if (response.ok) break;
        } catch { signal.throwIfAborted(); }
        if (Date.now() > deadline) throw Error('Server did not become ready within 30 seconds');
        await sleep(100, undefined, { signal });
      }
      console.info(`[dev] Mote ${version} (${p.profile}) ready at ${p.url}. Web rebuilt. Ctrl+C to stop.`);
    });
    const result = await server.done;
    signal.throwIfAborted();
    if (result.code !== 0) throw Error('Server exited unsuccessfully; see the output above');
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    controller.abort();
    if (server) await server.done;
    if (marker) {
      try {
        await withProfileLock(p, async () => {
          if ((await readJson(p.processFile, null))?.marker === marker) await rm(p.processFile, { force: true });
        });
      } catch (error) {
        // A replacement can be preparing its new record. It owns cleanup of the old one.
        if (error.message !== 'Another profile command is running') throw error;
      }
    }
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { profile: { type: 'string', default: 'dev' }, home: { type: 'string' }, pull: { type: 'boolean' }, install: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.info(help);
    else await runDevServer(values);
  } catch (error) { console.error(`[dev] ${error.message}`); process.exitCode = 1; }
}
