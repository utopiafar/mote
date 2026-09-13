import { readFile, writeFile, mkdir, rename, unlink, open, stat, lstat, readdir, copyFile, rm, rmdir, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { validateTunnel, tunnelTokenPath, dockerTunnelUser, removeTunnelSidecars, assertTunnelToken } from './tunnel-lib.mjs';

export const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const ports = { dev: 47842, test: 47852, prod: 47832 };
export function profilePaths(profile = 'dev', home = join(repository, '.mote/profiles')) {
  if (!Object.hasOwn(ports, profile)) throw Error('Profile must be dev, test or prod; default is dev');
  const directory = resolve(home, profile);
  const project = `mote-${profile}-${createHash('sha256').update(directory).digest('hex').slice(0, 10)}`;
  return { profile, home: resolve(home), directory, envFile: join(directory, 'mote.env'), metaFile: join(directory, 'profile.json'), processFile: join(directory, 'process.json'), project };
}
export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function initialize(paths, options = {}) {
  const port = Number(options.port ?? ports[paths.profile]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Port must be an integer between 1 and 65535');
  if (paths.profile !== 'prod' && port === ports.prod) throw Error('Port 47832 is reserved for the explicit prod profile');
  const runtime = options.runtime ?? 'native';
  if (!['native', 'docker'].includes(runtime)) throw Error('Runtime must be native or docker');
  if (options['data-dir'] && runtime !== 'native') throw Error('--data-dir is for native profiles; Docker uses --volume with a named volume');
  if (options.volume && runtime !== 'docker') throw Error('--volume requires a Docker profile');
  const dataDir = resolve(paths.directory, options['data-dir'] || 'data');
  const volume = options.volume || `${paths.project}-data`;
  if (!/^[a-z0-9][a-z0-9_.-]+$/i.test(volume)) throw Error('Invalid Docker volume name');
  if (paths.profile !== 'prod' && !volume.startsWith(paths.project + '-')) throw Error('Development/test volumes must belong to their own profile project');
  if (paths.profile !== 'prod') { const delta = relative(paths.directory, dataDir); if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw Error('Development/test storage must remain inside its profile directory'); }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  // Never overwrite a profile or silently rotate its token, including partially initialized profiles.
  for (const path of [paths.envFile, paths.metaFile]) {
    try { await stat(path); throw Error('Profile already exists; edit its private mote.env deliberately'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const folder of ['data', 'logs', 'backups', 'generated']) await mkdir(join(paths.directory, folder), { mode: 0o700 });
  const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
  const values = {
    MOTE_PROFILE: paths.profile, MOTE_HOST: '127.0.0.1', MOTE_PORT: String(port), MOTE_DATA_DIR: options['data-dir'] ? dataDir : './data',
    MOTE_TOKEN: randomBytes(32).toString('hex'), MOTE_DATA_KEY: '', MOTE_ALLOWED_ORIGINS: paths.profile === 'test' ? 'http://localhost:5174,http://127.0.0.1:5174' : 'http://localhost:5173,http://127.0.0.1:5173',
    MOTE_MODEL: '', MOTE_MODEL_BASE_URL: 'https://api.deepseek.com', MOTE_MODEL_API_KEY: '', MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL: '0',
    MOTE_MODEL_REASONING_EFFORT: 'high', MOTE_MODEL_MAX_TOKENS: '8192',
    MOTE_EMBEDDING_MODEL: '', MOTE_EMBEDDING_BASE_URL: '', MOTE_EMBEDDING_API_KEY: '',
    MOTE_RETENTION_DAYS: '0', MOTE_MAX_STORAGE_MB: '10240', MOTE_MAX_EXPORT_MB: '64', MOTE_INSIGHT_INTERVAL_HOURS: '0',
    MOTE_LOG_DIR: './logs', MOTE_DIAGNOSTICS_ENABLED: '1', MOTE_DEBUG: '0', MOTE_LOG_LEVEL: 'info', MOTE_LOG_MAX_MB: '2', MOTE_LOG_MAX_FILES: '3', MOTE_LOG_MAX_ENTRIES: '2000',
    MOTE_PUBLIC_URL: '',
    MOTE_TLS_DOMAIN: '', MOTE_TLS_HTTP_PORT: '80', MOTE_TLS_HTTPS_PORT: '443',
  };
  // Retain the documented settings and comments; only this profile's defaults replace example values.
  const template = await readFile(join(repository, '.env.example'), 'utf8');
  const remaining = new Set(Object.keys(values));
  function line(key, value) {
    for (const quote of ["'", '"', '`']) {
      if (value.includes(quote) || /[\r\n\0]/.test(value)) continue;
      const candidate = `${key}=${quote}${value}${quote}`;
      if (parseEnv(candidate)[key] === value) return candidate;
    }
    throw Error('A configuration value cannot be represented safely; choose a path without quote delimiters');
  }
  const body = template.split('\n').filter(l => !l.startsWith('# Legacy single-node') && !l.includes('直接 npm start') && !l.includes('隔离部署先执行')).map(l => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(l);
    if (!match || !Object.hasOwn(values, match[1])) return l;
    remaining.delete(match[1]); return line(match[1], values[match[1]]);
  });
  const contents = '# Private isolated profile. Relative paths resolve beside this file. Do not commit.\n' + body.join('\n') + '\n# Deployment selection and optional public endpoint; tunnel secrets use a separate private file.\n' + Array.from(remaining, key => line(key, values[key])).join('\n') + '\n';
  await writeFile(paths.envFile, contents, { flag: 'wx', mode: 0o600 });
  await atomicJson(paths.metaFile, { version: 1, profile: paths.profile, runtime, release: repository, image: options.image ?? `mote-central:${version}`, volume, tls: false });
  return { profile: paths.profile, runtime, port, envFile: paths.envFile, storage: { kind: runtime === 'docker' ? 'docker-volume' : 'local-directory', source: runtime === 'docker' ? volume : dataDir, mount: runtime === 'docker' ? '/data' : dataDir }, dataDir: runtime === 'native' ? dataDir : undefined, volume: runtime === 'docker' ? volume : undefined, project: paths.project };
}
export async function loadProfile(paths) {
  let env, meta;
  try { env = parseEnv(await readFile(paths.envFile, 'utf8')); meta = await readJson(paths.metaFile); }
  catch (error) { if (error.code === 'ENOENT') throw Error(`Profile is not initialized: run init --profile ${paths.profile}`); throw Error('Profile configuration could not be parsed; contents are suppressed'); }
  if (meta.version !== 1 || meta.profile !== paths.profile || !['native', 'docker'].includes(meta.runtime)) throw Error('Profile metadata is invalid');
  if (env.MOTE_PROFILE !== paths.profile) throw Error('mote.env profile does not match its directory');
  validateTunnel(meta.tunnel);
  if (Object.keys(env).some(k => k.startsWith('DOCKER_') || k.startsWith('COMPOSE_'))) throw Error('Docker context and Compose selection belong to the CLI environment, not mote.env');
  if (Object.keys(env).some(k => k.startsWith('TUNNEL_') || k.startsWith('CLOUDFLARED_') || k === 'NO_AUTOUPDATE' || k.startsWith('MOTE_TUNNEL_TOKEN'))) throw Error('Provider credential/environment flags are not allowed in mote.env; use tunnel --token-file');
  const port = Number(env.MOTE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid profile MOTE_PORT');
  if (paths.profile !== 'prod' && port === ports.prod) throw Error('Port 47832 is reserved for the explicit prod profile');
  if (!env.MOTE_TOKEN || env.MOTE_TOKEN.length < 32 || /[\r\n]/.test(env.MOTE_TOKEN)) throw Error('Profile requires a token of at least 32 characters');
  if (!/^[a-z0-9][a-z0-9_.-]+$/i.test(meta.volume)) throw Error('Invalid profile volume');
  if (paths.profile !== 'prod' && !meta.volume.startsWith(paths.project + '-')) throw Error('Development/test volumes must belong to their own profile project');
  if (meta.tls && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(env.MOTE_TLS_DOMAIN ?? '') || !(env.MOTE_TLS_DOMAIN ?? '').includes('.'))) throw Error('TLS requires a valid domain in MOTE_TLS_DOMAIN');
  const dataDir = resolve(paths.directory, env.MOTE_DATA_DIR || 'data');
  if (paths.profile !== 'prod') for (const path of [dataDir, resolve(paths.directory, env.MOTE_LOG_DIR || 'logs')]) {
    const delta = relative(paths.directory, path);
    if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw Error('Development/test data and logs must remain inside their own profile directory');
    // Existing symlinks cannot retarget an otherwise isolated profile into a formal vault.
    let cursor = path;
    while (cursor !== paths.directory) {
      try { if ((await lstat(cursor)).isSymbolicLink()) throw Error('Development/test data and log paths cannot contain symlinks'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      cursor = dirname(cursor);
    }
  }
  return { ...paths, env, meta, port, dataDir, url: `http://127.0.0.1:${port}` };
}
export function deploymentEnvironment(p) {
  const tunnel = validateTunnel(p.meta.tunnel), docker = p.meta.runtime === 'docker';
  return { MOTE_RUNTIME: p.meta.runtime, MOTE_CONFIG_FILE: p.envFile, MOTE_STORAGE_KIND: docker ? 'docker-volume' : 'local-directory', MOTE_STORAGE_SOURCE: docker ? p.meta.volume : p.dataDir, MOTE_STORAGE_MOUNT: docker ? '/data' : p.dataDir,
    MOTE_PUBLIC_URL: p.env.MOTE_PUBLIC_URL || '',
    MOTE_TUNNEL_ENABLED: tunnel.enabled ? '1' : '0', MOTE_TUNNEL_PROVIDER: tunnel.enabled ? 'cloudflare' : '', MOTE_TUNNEL_PROTOCOL: tunnel.enabled ? tunnel.protocol : '' };
}
export function effectiveConfiguration(p) {
  const d = deploymentEnvironment(p), tunnel = validateTunnel(p.meta.tunnel);
  const endpoint = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash ? u.toString() : '[invalid endpoint hidden]'; } catch { return value ? '[invalid endpoint hidden]' : ''; } };
  return { profile: p.profile, runtime: p.meta.runtime, configurationFile: p.envFile, processEnvFile: p.meta.runtime === 'docker' ? '/app/deploy/empty.env' : p.envFile, metadataFile: p.metaFile,
    listener: { host: p.meta.runtime === 'docker' ? '0.0.0.0' : p.env.MOTE_HOST, port: p.meta.runtime === 'docker' ? 47832 : p.port, publishedUrl: p.url, publicUrl: endpoint(d.MOTE_PUBLIC_URL) },
    storage: { kind: d.MOTE_STORAGE_KIND, source: d.MOTE_STORAGE_SOURCE, mount: d.MOTE_STORAGE_MOUNT, logPath: p.meta.runtime === 'docker' ? '/data/logs' : resolve(p.directory, p.env.MOTE_LOG_DIR || join(p.dataDir,'logs')), dataKeyConfigured: Boolean(p.env.MOTE_DATA_KEY) },
    credentials: { accessTokenConfigured: Boolean(p.env.MOTE_TOKEN), modelKeyConfigured: Boolean(p.env.MOTE_MODEL_API_KEY), embeddingKeyConfigured: Boolean(p.env.MOTE_EMBEDDING_API_KEY) },
    models: { model: p.env.MOTE_MODEL || '', endpoint: endpoint(p.env.MOTE_MODEL_BASE_URL), embeddingModel: p.env.MOTE_EMBEDDING_MODEL || '', embeddingEndpoint: endpoint(p.env.MOTE_EMBEDDING_BASE_URL) },
    archive: { retentionDays: Number(p.env.MOTE_RETENTION_DAYS || 0), maxStorageMiB: Number(p.env.MOTE_MAX_STORAGE_MB || 10240), maxExportMiB: Number(p.env.MOTE_MAX_EXPORT_MB || 64) },
    tunnel: { configured: tunnel.enabled, provider: tunnel.enabled ? 'cloudflare' : null, protocol: tunnel.protocol, connected: 'not-checked', originService: p.meta.runtime === 'docker' ? 'http://mote:47832' : p.url, supervision: p.meta.runtime === 'docker' ? 'compose' : 'foreground-runner' },
    apply: 'Edit the selected private configuration and restart this profile; existing archive data is not moved automatically' };
}
export function isolatedEnvironment(p, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MOTE_') || key.startsWith('COMPOSE_') || key.startsWith('TUNNEL_') || key.startsWith('CLOUDFLARED_') || key === 'NO_AUTOUPDATE') delete env[key];
  return { ...env, ...p.env, ...deploymentEnvironment(p), NODE_ENV: p.profile === 'prod' ? 'production' : p.profile === 'test' ? 'test' : 'development', MOTE_ENV_FILE: p.envFile, MOTE_PROFILE: p.profile, MOTE_URL: p.url, MOTE_TOKEN_FILE: join(p.dataDir, 'access-token'), ...extra };
}
export function execute(command, args, { env, cwd = repository, capture = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '', timedOut = false;
    let killTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutMs);
    if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill('SIGTERM'); });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); if (code === 0 && !timedOut) resolvePromise(output.trim()); else reject(Error(`${command} ${args[0] ?? ''} ${timedOut ? 'timed out' : `exited ${code}`}${capture ? '; diagnostic output suppressed to avoid exposing configuration' : ''}`)); });
  });
}
export async function withProfileLock(p, operation) {
  const path = join(p.directory, 'lifecycle.lock');
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = await open(path, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner < 1) throw Error('Invalid lifecycle lock; inspect it before removing it');
      try { process.kill(owner, 0); throw Error('Another profile command is running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await unlink(path);
    }
  }
  if (!fd) throw Error('Could not acquire profile lock');
  try { await fd.writeFile(String(process.pid)); return await operation(); }
  finally { await fd.close(); await unlink(path); }
}
export async function nativeIdentity(p) {
  const record = await readJson(p.processFile, null);
  if (!record) return { running: false, managed: false };
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !/^[a-f0-9-]{36}$/.test(record.marker)) throw Error('Invalid managed process record');
  const probe = pid => {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return { running: false, managed: false }; throw error; }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return { running: true, managed: result.status === 0 && new RegExp(`(?:^|\\s)--mote-instance=${record.marker}(?:\\s|$)`).test(result.stdout) };
  };
  const supervisor = probe(record.pid);
  if (supervisor.managed) return { ...supervisor, record };
  // A SIGKILLed supervisor can leave its central child alive. The vault PID alone is never authority:
  // recover only the child with this exact saved instance marker, otherwise refuse unrelated processes.
  try {
    const pid = Number((await readFile(join(p.dataDir, 'server.pid'), 'utf8')).trim());
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== record.pid) {
      const child = probe(pid);
      if (child.managed) return { ...child, recoveredChild: true, record: { ...record, supervisorPid: record.pid, pid } };
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...supervisor, record };
}
export async function health(p) {
  try { const response = await fetch(p.url + '/api/status', { headers: { Authorization: `Bearer ${p.env.MOTE_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(1500) }); return response.ok; }
  catch { return false; }
}
async function ensurePortFree(p) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer(); server.once('error', () => reject(Error(`Port ${p.port} is already in use; this command will not stop or connect collectors to that service`)));
    server.listen(p.port, p.env.MOTE_HOST || '127.0.0.1', () => server.close(resolvePromise));
  });
}
export async function startNative(p, foreground = false) {
  const current = await nativeIdentity(p);
  if (current.running) {
    if (!current.managed) throw Error('Recorded PID belongs to another process; refusing to use or stop it');
    if (!foreground) return { alreadyRunning: true, pid: current.record.pid };
    // launchd may restart this command after the runner was killed. Stay attached to the verified
    // surviving child instead of exiting successfully and silently abandoning supervision.
    let stopping = false; const expectedMarker = current.record.marker;
    const forward = () => { stopping = true; void stopNative(p, expectedMarker).catch(() => undefined); };
    process.on('SIGTERM', forward); process.on('SIGINT', forward);
    return { pid: current.record.pid, recoveredChild: current.recoveredChild, wait: async () => {
      try { while (true) { const state = await nativeIdentity(p); if (!state.running || !state.managed || state.record.marker !== expectedMarker) return { code: stopping ? 0 : 1 }; await sleep(250); } }
      finally { process.off('SIGTERM', forward); process.off('SIGINT', forward); }
    } };
  }
  const entry = join(resolve(p.meta.release), 'apps/server/dist/index.js');
  await stat(entry).catch(() => { throw Error('Central build is missing. Run npm ci, build:libs, and build server/web in the selected release'); });
  await ensurePortFree(p);
  const marker = randomUUID(); await mkdir(join(p.directory, 'logs'), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [join(repository, 'scripts/central-runner.mjs'), entry, join(p.directory, 'logs/central.log'), `--mote-instance=${marker}`], { cwd: resolve(p.meta.release), env: isolatedEnvironment(p), detached: !foreground, stdio: foreground ? 'inherit' : 'ignore' });
  let failure; child.once('error', error => { failure = error; });
  const exited = new Promise(resolvePromise => child.once('close', (code, signal) => resolvePromise({ code, signal })));
  if (!child.pid) throw Error('Could not start central process');
  const record = { pid: child.pid, marker, envFile: p.envFile, release: p.meta.release, startedAt: new Date().toISOString() };
  try { await atomicJson(p.processFile, record); } catch (error) { child.kill('SIGTERM'); throw error; }
  const deadline = Date.now() + 20000;
  while (!(await health(p))) {
    if (failure || child.exitCode !== null || child.signalCode !== null) throw Error(`Central exited during startup; inspect ${join(p.directory, 'logs/central.log')}`);
    if (Date.now() > deadline) { child.kill('SIGTERM'); throw Error('Central did not become healthy within 20 seconds; process was asked to stop'); }
    await sleep(100);
  }
  if (!foreground) { child.unref(); return { pid: child.pid, url: p.url }; }
  const forward = signal => child.kill(signal);
  const term = () => forward('SIGTERM'), interrupt = () => forward('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  return { pid: child.pid, wait: async () => { try { return await exited; } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); } } };
}
export async function stopNative(p, expectedMarker) {
  const current = await nativeIdentity(p);
  if (!current.running) return { stopped: true, alreadyStopped: true };
  if (expectedMarker && current.record.marker !== expectedMarker) return { stopped: true, alreadyStopped: true };
  if (!current.managed) throw Error('Recorded PID belongs to another process; refusing to signal it');
  const marker = current.record.marker;
  process.kill(current.record.pid, 'SIGTERM');
  const deadline = Date.now() + 20000;
  while (true) {
    const state = await nativeIdentity(p);
    if (!state.running || !state.managed || state.record.marker !== marker) break;
    if (Date.now() > deadline) throw Error('Graceful shutdown is still in progress; no forced kill was sent'); await sleep(100);
  }
  return { stopped: true };
}
export function composeEnvironment(p) {
  return isolatedEnvironment(p, { MOTE_COMPOSE_PROJECT: p.project, MOTE_IMAGE: p.meta.image, MOTE_VOLUME: p.meta.volume, MOTE_DOCKER_ENV_FILE: join(p.directory, 'generated/docker.env'), MOTE_BIND_ADDRESS: '127.0.0.1', MOTE_TUNNEL_IMAGE: validateTunnel(p.meta.tunnel).image, MOTE_TUNNEL_TOKEN_FILE: tunnelTokenPath(p), MOTE_TUNNEL_USER: p.tunnelUser || `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}` });
}
export function composeArgs(p, args) {
  return ['compose', '--project-name', p.project, '--project-directory', repository, '--env-file', join(repository, 'deploy/empty.env'), '-f', join(repository, 'compose.yaml'), ...(p.meta.tls ? ['-f', join(repository, 'compose.tls.yaml')] : []), ...(validateTunnel(p.meta.tunnel).enabled ? ['-f', join(repository, 'compose.tunnel.yaml')] : []), ...args];
}
export async function compose(p, args, options = {}) {
  // Parse dotenv once with Node, then pass literal values to Compose raw env_file. No root .env or shell interpolation.
  const tunnel = validateTunnel(p.meta.tunnel);
  if (tunnel.enabled && ['up','create','run','restart'].includes(args[0])) { await assertTunnelToken(p); p.tunnelUser = await dockerTunnelUser(p, execute); }
  else if (args[0] === 'up' && p.meta.tunnel) await removeTunnelSidecars(p, execute);
  const lines = Object.entries({ ...p.env, ...deploymentEnvironment(p) }).map(([key, value]) => { if (/[\r\n]/.test(value)) throw Error('Docker profile values must be single-line'); return `${key}=${value}`; });
  const file = join(p.directory, 'generated/docker.env'), temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
  return execute('docker', composeArgs(p, args), { env: composeEnvironment(p), ...options });
}
export async function dockerContainer(p) {
  const ids = (await compose(p, ['ps', '--all', '--quiet', 'mote'], { capture: true })).split(/\s+/).filter(Boolean);
  if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) throw Error('Expected one profile container; run compose -- create mote first');
  return ids[0];
}
export async function assertDockerStopped(p) {
  const id = await dockerContainer(p);
  const running = await execute('docker', ['inspect', '--format', '{{.State.Running}}', id], { capture: true });
  if (running !== 'false') throw Error('Stop this profile before backup or restore');
  return id;
}
export async function assertVaultStopped(directory) {
  try {
    const pid = Number((await readFile(join(directory, 'server.pid'), 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid vault server.pid; inspect it before restoring');
    try { process.kill(pid, 0); throw Error('The selected vault is used by a running central process; stop it before restore'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function backupProfile(p, out) {
  const destination = resolve(out ?? join(p.directory, 'backups', new Date().toISOString().replace(/[:.]/g, '-')));
  let source = p.dataDir, stage;
  try {
    if (p.meta.runtime === 'docker') {
      const id = await assertDockerStopped(p);
      stage = join(p.directory, 'backups', `.copy-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
      await execute('docker', ['cp', `${id}:/data/.`, stage], { capture: true });
      // A stopped container's PID namespace is unrelated to host PIDs. Remove only the copied lock.
      await rm(join(stage, 'server.pid'), { force: true }); source = stage;
    }
    await execute(process.execPath, [join(repository, 'scripts/backup.ts'), '--data', source, '--out', destination], { env: isolatedEnvironment(p) });
    return destination;
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
}
async function sha(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export async function verifiedBackup(backup) {
  const directory = await realpath(resolve(backup));
  const manifestPath = join(directory, 'backup-manifest.json');
  if ((await stat(manifestPath)).size > 16 * 1024 * 1024) throw Error('Backup manifest exceeds 16 MiB');
  const manifest = await readJson(manifestPath);
  if (manifest.version !== 1 || !manifest.checksums || !Object.hasOwn(manifest.checksums, 'mote.sqlite')) throw Error('Invalid backup manifest');
  for (const [name, hash] of Object.entries(manifest.checksums)) {
    if (!(name === 'mote.sqlite' || /^blobs\/[a-f0-9]{64}$/.test(name)) || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Unsafe backup manifest entry');
    if (!(await lstat(join(directory, name))).isFile() || (await realpath(join(directory, name))) !== join(directory, name)) throw Error('Backup links are not allowed');
    if (await sha(join(directory, name)) !== hash) throw Error('Backup checksum mismatch; active data was not changed');
  }
  return { directory, names: Object.keys(manifest.checksums), checksums: manifest.checksums };
}
export async function restoreProfile(p, backup) {
  const checked = await verifiedBackup(backup);
  const stage = join(p.meta.runtime === 'native' ? dirname(p.dataDir) : p.directory, `.mote-restore-${randomUUID()}`); await mkdir(join(stage, 'blobs'), { recursive: true, mode: 0o700 });
  try {
    for (const name of checked.names) {
      await copyFile(join(checked.directory, name), join(stage, name));
      if (await sha(join(stage, name)) !== checked.checksums[name]) throw Error('Backup changed while copying; active data was not changed');
    }
    if (p.meta.runtime === 'docker') {
      const existing = (await compose(p, ['ps', '--all', '--quiet', 'mote'], { capture: true })).trim();
      if (existing) await assertDockerStopped(p);
      await compose(p, ['create', '--no-build', 'mote'], { capture: true });
      const id = await assertDockerStopped(p);
      await compose(p, ['run', '--rm', '--no-deps', 'mote', 'node', '-e', "if(require('node:fs').readdirSync('/data').length)process.exit(2)"], { capture: true });
      await execute('docker', ['cp', `${stage}/.`, `${id}:/data`], { capture: true });
      await compose(p, ['run', '--rm', '--no-deps', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', 'mote', 'chown', '-R', 'node:node', '/data'], { capture: true });
    } else {
      if ((await nativeIdentity(p)).running) throw Error('Stop this profile before restore');
      await assertVaultStopped(p.dataDir);
      await mkdir(p.dataDir, { recursive: true, mode: 0o700 });
      if ((await readdir(p.dataDir)).length) throw Error('Restore requires an empty data directory; existing data is never overwritten');
      await rmdir(p.dataDir); await rename(stage, p.dataDir);
    }
    return { restored: true, source: checked.directory };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export function launchdXml(p, nodePath = process.execPath) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const label = `dev.mote.central.${p.profile}.${p.project.split('-').at(-1)}`;
  const args = [resolve(nodePath), join(repository, 'scripts/mote.mjs'), 'run', '--profile', p.profile, '--home', p.home];
  const strings = args.map(value => `<string>${escape(value)}</string>`).join('');
  return { label, contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${strings}</array><key>WorkingDirectory</key><string>${escape(repository)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n` };
}

export async function setPublicUrl(p, url) {
  const raw = await readFile(p.envFile,'utf8');
  const entry = `MOTE_PUBLIC_URL=${JSON.stringify(url)}`;
  if (parseEnv(entry).MOTE_PUBLIC_URL !== url) throw Error('Public URL cannot be represented in configuration');
  const next = /^MOTE_PUBLIC_URL=/m.test(raw) ? raw.replace(/^MOTE_PUBLIC_URL=.*$/m,entry) : raw + '\n' + entry + '\n';
  const beforeValues = parseEnv(raw), afterValues = parseEnv(next);
  if (afterValues.MOTE_PUBLIC_URL !== url || JSON.stringify(Object.entries(beforeValues).filter(([key]) => key !== 'MOTE_PUBLIC_URL').sort()) !== JSON.stringify(Object.entries(afterValues).filter(([key]) => key !== 'MOTE_PUBLIC_URL').sort())) throw Error('Cannot update MOTE_PUBLIC_URL safely; remove duplicate keys or edit this field manually');
  const temp = `${p.envFile}.${randomUUID()}.tmp`;
  try { await writeFile(temp,next,{flag:'wx',mode:0o600}); await rename(temp,p.envFile); }
  finally { await rm(temp,{force:true}); }
}
