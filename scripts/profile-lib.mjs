import { readFile, writeFile, mkdir, rename, unlink, open, stat, lstat, readdir, copyFile, rm, rmdir, realpath, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigDocument, parseConfigDocument, serializeConfigDocument, redactConfigDocument, configSecretEnvironment } from '../packages/shared/src/config-file.ts';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import {safePluginBackupPath} from './plugin-memory-backup.mjs';
import {restoreHindsight} from './hindsight-backup.mjs';
import { validateTunnel, tunnelTokenPath, dockerTunnelUser, removeTunnelSidecars, assertTunnelToken } from './tunnel-lib.mjs';
import { logRetentionFromDocument, MiB } from '../apps/server/src/log-retention-config.mjs';

export const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const ports = { dev: 47842, test: 47852, prod: 47832 };
export function profilePaths(profile = 'dev', home = join(repository, '.mote/profiles')) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile) || profile === 'legacy') throw Error('Profile must be a 1–32 character isolated name; legacy is not managed by this CLI');
  const directory = resolve(home, profile);
  const project = `mote-${profile}-${createHash('sha256').update(directory).digest('hex').slice(0, 10)}`;
  return { profile, home: resolve(home), directory, configFile: join(directory, 'mote.yaml'), legacyEnvFile: join(directory, 'mote.env'), metaFile: join(directory, 'profile.json'), processFile: join(directory, 'process.json'), project };
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
  const port = Number(options.port ?? ports[paths.profile] ?? ports.dev);
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
  // Never overwrite a profile, including a legacy or partly initialized one.
  for (const path of [paths.configFile, paths.legacyEnvFile, paths.metaFile]) {
    try { await stat(path); throw Error('Profile already exists; edit its private mote.yaml deliberately. Legacy mote.env profiles require an explicit offline replacement.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const folder of ['data', 'logs', 'backups', 'generated']) await mkdir(join(paths.directory, folder), { mode: 0o700 });
  const version = JSON.parse(await readFile(join(repository, 'apps/server/package.json'), 'utf8')).version;
  const docker = runtime === 'docker';
  const profilePort = (role, base) => base + parseInt(createHash('sha256').update(`${paths.project}:media:${role}`).digest('hex').slice(0, 8), 16) % 20000;
  const asrPort = docker ? 9009 : profilePort('asr', 20000), ocrPort = docker ? 9010 : profilePort('ocr', 40000);
  const token = randomBytes(32).toString('hex');
  const document = {
    version: 1, revision: 0,
    server: { profile: paths.profile, runtime, host: docker ? '0.0.0.0' : '127.0.0.1', port, token, hostConfigFile: paths.configFile,
      allowedOrigins: (paths.profile === 'test' ? ['http://localhost:5174', 'http://127.0.0.1:5174'] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
      tls: { enabled: false, domain: '', httpPort: 80, httpsPort: 443 } },
    storage: { dataDir: docker ? '/data' : options['data-dir'] ? dataDir : './data', kind: docker ? 'docker-volume' : 'local-directory', source: docker ? volume : dataDir, mount: docker ? '/data' : '' },
    execution: {}, diagnostics: { directory: docker ? '/data/logs' : './logs', debug: paths.profile === 'dev', traceEnabled: paths.profile === 'dev' },
    models: { deployment: { provider: 'codex', protocol: 'codex-app-server', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
    connectors: {}, plugins: {}, updates: {},
    media: { modelDirectory: docker ? '/models' : './models', python: docker ? '/opt/mote-media-venv/bin/python' : './media-venv/bin/python', asrPort, ocrPort,
      asrEndpoint: `http://127.0.0.1:${asrPort}/transcribe`, ocrEndpoint: `http://127.0.0.1:${ocrPort}/ocr`, workerToken: createHash('sha256').update('mote-media-worker:').update(token).digest('hex') },
  };
  await writeFile(paths.configFile, '# Private isolated profile. Relative paths resolve beside this file. Do not commit.\n' + serializeConfigDocument(document), { flag: 'wx', mode: 0o600 });
  await atomicJson(paths.metaFile, { version: 1, profile: paths.profile, runtime, release: repository, image: options.image ?? `mote-central:${version}`, volume, modelsVolume: volume + '-models' });
  return { profile: paths.profile, runtime, port, configurationFile: paths.configFile, storage: { kind: docker ? 'docker-volume' : 'local-directory', source: docker ? volume : dataDir, mount: docker ? '/data' : dataDir }, dataDir: docker ? undefined : dataDir, volume: docker ? volume : undefined, project: paths.project };
}
// These derived values support device-client bridges and existing lifecycle consumers.
// They are never passed to the server as ordinary configuration overrides.
function connectionValues(document, baseDir) {
  const server = document.server ?? {}, storage = document.storage ?? {}, models = document.models ?? {}, diagnostics = document.diagnostics ?? {}, media = document.media ?? {};
  const model = models.deployment ?? {}, embedding = models.embedding ?? {}, tls = server.tls ?? {}, limits = logRetentionFromDocument(document);
  return { MOTE_TOKEN: server.token ?? '', MOTE_PROFILE: server.profile ?? 'default', MOTE_PORT: String(server.port ?? 47832), MOTE_HOST: server.host ?? '127.0.0.1', MOTE_PUBLIC_URL: server.publicUrl ?? '',
    MOTE_DATA_DIR: storage.dataDir ?? './data', MOTE_DATA_KEY: storage.dataKey ?? '', MOTE_CONTENT_ENCRYPTION: storage.contentEncryptionEnabled ? '1' : '0',
    MOTE_MODEL: model.model ?? '', MOTE_MODEL_API_KEY: model.apiKey ?? '', MOTE_MODEL_BASE_URL: model.baseUrl ?? '', MOTE_EMBEDDING_MODEL: embedding.model ?? '', MOTE_EMBEDDING_API_KEY: embedding.apiKey ?? '', MOTE_EMBEDDING_BASE_URL: embedding.baseUrl ?? '',
    MOTE_LOG_DIR: diagnostics.directory ?? './logs', MOTE_LOG_MAX_MB: String(limits.maxBytes / MiB), MOTE_LOG_MAX_FILES: String(limits.maxFiles), MOTE_LOG_MAX_ENTRIES: String(limits.maxEntries), MOTE_AGENT_TRACE_ENABLED: diagnostics.traceEnabled ? '1' : '0',
    MOTE_MAX_STORAGE_MB: String((storage.maxStorageBytes ?? 10240 * 1024 * 1024) / 1024 / 1024), MOTE_MAX_EXPORT_MB: String((storage.maxExportBytes ?? 64 * 1024 * 1024) / 1024 / 1024), MOTE_RETENTION_DAYS: String(storage.retentionDays ?? 0),
    MOTE_UPDATE_REPOSITORY: document.updates?.repository ?? 'utopiafar/mote', MOTE_UPDATE_CHANNEL: document.updates?.channel ?? 'stable',
    MOTE_TLS_DOMAIN: tls.domain ?? '', MOTE_TLS_HTTP_PORT: String(tls.httpPort ?? 80), MOTE_TLS_HTTPS_PORT: String(tls.httpsPort ?? 443),
    MOTE_MEDIA_MODEL_DIR: media.modelDirectory ? resolve(baseDir, media.modelDirectory) : '', MOTE_MEDIA_PYTHON: media.python ? resolve(baseDir, media.python) : '',
    MOTE_MEDIA_ASR_ENDPOINT: media.asrEndpoint ?? '', MOTE_MEDIA_OCR_ENDPOINT: media.ocrEndpoint ?? '', MOTE_MEDIA_ASR_PORT: String(media.asrPort ?? 9009), MOTE_MEDIA_OCR_PORT: String(media.ocrPort ?? 9010), MOTE_MEDIA_WORKER_TOKEN: media.workerToken ?? '',
  };
}
function dockerModelDirectory(document) {
  const value = document.media?.modelDirectory || '/models';
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0,:]/.test(value)) throw Error('Docker media.modelDirectory must be an absolute container path without comma or colon');
  const target = resolve(value);
  if (target === '/' || ['/config', '/data', '/app'].some(path => target === path || target.startsWith(path + '/') || path.startsWith(target + '/'))) throw Error('Docker media.modelDirectory would hide the configuration, archive or application mount');
  return target;
}
export async function loadProfile(paths) {
  let loaded, meta;
  try { loaded = readConfigDocument(paths.configFile); meta = await readJson(paths.metaFile); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (await stat(paths.legacyEnvFile).then(() => true, failure => failure.code === 'ENOENT' ? false : Promise.reject(failure))) throw Error('Legacy mote.env profiles are unsupported. Stop the old release and explicitly create mote.yaml offline; no files or archive data have been migrated.');
      throw Error(`Profile is not initialized: run init --profile ${paths.profile}`);
    }
    throw Error('Profile configuration could not be parsed; contents are suppressed');
  }
  const document = loaded.document, env = connectionValues(document, paths.directory);
  if (meta.version !== 1 || meta.profile !== paths.profile || !['native', 'docker'].includes(meta.runtime)) throw Error('Profile metadata is invalid');
  if (document.server?.profile !== paths.profile || document.server?.runtime !== meta.runtime) throw Error('mote.yaml profile/runtime does not match its deployment metadata');
  const tunnel = validateTunnel(meta.tunnel);
  meta.tunnel = { ...tunnel, enabled: document.server?.tunnelEnabled ?? false, protocol: document.server?.tunnelProtocol ?? 'auto' };
  validateTunnel(meta.tunnel);
  meta.tls = document.server?.tls?.enabled ?? false;
  const port = Number(env.MOTE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid profile server.port');
  if (paths.profile !== 'prod' && port === ports.prod) throw Error('Port 47832 is reserved for the explicit prod profile');
  if (!env.MOTE_TOKEN || env.MOTE_TOKEN.length < 32 || /[\r\n]/.test(env.MOTE_TOKEN)) throw Error('Profile requires server.token of at least 32 characters');
  if (!/^[a-z0-9][a-z0-9_.-]+$/i.test(meta.volume)) throw Error('Invalid profile volume');
  if (paths.profile !== 'prod' && !meta.volume.startsWith(paths.project + '-')) throw Error('Development/test volumes must belong to their own profile project');
  if (meta.modelsVolume && (!/^[a-z0-9][a-z0-9_.-]+$/i.test(meta.modelsVolume) || paths.profile !== 'prod' && !meta.modelsVolume.startsWith(paths.project + '-'))) throw Error('Invalid profile models volume');
  if (meta.tls && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(env.MOTE_TLS_DOMAIN) || !env.MOTE_TLS_DOMAIN.includes('.'))) throw Error('TLS requires a valid domain in server.tls.domain');
  const dataDir = meta.runtime === 'docker' ? '/data' : resolve(paths.directory, env.MOTE_DATA_DIR);
  const modelDirectory = meta.runtime === 'docker' ? dockerModelDirectory(document) : resolve(paths.directory, document.media?.modelDirectory || './models');
  if (meta.runtime === 'docker') {
    if (env.MOTE_DATA_DIR !== '/data' || env.MOTE_LOG_DIR !== '/data/logs' || document.storage?.source !== meta.volume) throw Error('Docker profiles require storage.dataDir=/data, diagnostics.directory=/data/logs and their selected named storage.source');
  } else if (paths.profile !== 'prod') for (const path of [dataDir, resolve(paths.directory, env.MOTE_LOG_DIR)]) {
    const delta = relative(paths.directory, path);
    if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw Error('Development/test data and logs must remain inside their own profile directory');
    let cursor = path;
    while (cursor !== paths.directory) {
      try { if ((await lstat(cursor)).isSymbolicLink()) throw Error('Development/test data and log paths cannot contain symlinks'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      cursor = dirname(cursor);
    }
  }
  return { ...paths, document, savedDocument: loaded.savedDocument, env, meta, port, dataDir, modelDirectory, url: `http://127.0.0.1:${port}` };
}
export function deploymentEnvironment(p) {
  const tunnel = validateTunnel(p.meta.tunnel), docker = p.meta.runtime === 'docker';
  return { MOTE_RUNTIME: p.meta.runtime, MOTE_CONFIG_FILE: p.configFile, MOTE_STORAGE_KIND: docker ? 'docker-volume' : 'local-directory', MOTE_STORAGE_SOURCE: docker ? p.meta.volume : p.dataDir, MOTE_STORAGE_MOUNT: docker ? '/data' : '',
    ...Object.fromEntries(Object.entries(p.env).filter(([name]) => name.startsWith('MOTE_MEDIA_'))), MOTE_PUBLIC_URL: p.env.MOTE_PUBLIC_URL || '',
    MOTE_TUNNEL_ENABLED: tunnel.enabled ? '1' : '0', MOTE_TUNNEL_PROVIDER: tunnel.enabled ? 'cloudflare' : '', MOTE_TUNNEL_PROTOCOL: tunnel.enabled ? tunnel.protocol : '' };
}
export function effectiveConfiguration(p) {
  const tunnel = validateTunnel(p.meta.tunnel), redacted = redactConfigDocument(p.document);
  return { profile: p.profile, runtime: p.meta.runtime, configurationFile: p.configFile, metadataFile: p.metaFile,
    document: redacted,
    listener: { host: p.document.server.host, port: p.port, publishedUrl: p.url, publicUrl: redacted.server?.publicUrl || null },
    storage: { kind: p.document.storage.kind, source: p.document.storage.source, mount: p.document.storage.mount || null, logPath: p.env.MOTE_LOG_DIR, dataKeyConfigured: Boolean(p.env.MOTE_DATA_KEY) },
    credentials: { accessTokenConfigured: Boolean(p.env.MOTE_TOKEN), modelKeyConfigured: Boolean(p.env.MOTE_MODEL_API_KEY), embeddingKeyConfigured: Boolean(p.env.MOTE_EMBEDDING_API_KEY) },
    diagnostics: effectiveLogRetention(p),
    models: { model: p.env.MOTE_MODEL || '', endpoint: redacted.models?.deployment?.baseUrl ?? '', embeddingModel: p.env.MOTE_EMBEDDING_MODEL || '', embeddingEndpoint: redacted.models?.embedding?.baseUrl ?? '' },
    updates: { repository: p.env.MOTE_UPDATE_REPOSITORY, channel: p.env.MOTE_UPDATE_CHANNEL, verifiedManifestRequired: true, installation: 'explicit-profile-command' },
    tunnel: { configured: tunnel.enabled, provider: tunnel.enabled ? 'cloudflare' : null, protocol: tunnel.protocol, connected: 'not-checked', originService: p.meta.runtime === 'docker' ? `http://mote:${p.port}` : p.url, supervision: p.meta.runtime === 'docker' ? 'compose' : 'foreground-runner' },
    apply: 'Hot-reloadable sections apply after validation. Server, storage paths, plugin modules and managed media resources require restart or an explicit migration.' };
}
export function effectiveLogRetention(p) {
  const limits = logRetentionFromDocument(p.document);
  return { logMaxMiB: limits.maxBytes / MiB, logMaxFiles: limits.maxFiles, logMaxEntries: limits.maxEntries, logMaxMiBSource: limits.source };
}
export async function assertLogRetentionCompatible(p, { execute: run = execute } = {}) {
  const limits = logRetentionFromDocument(p.document);
  // Every selected target must understand the canonical YAML. Older YAML-aware
  // targets may still work with an explicit compatible file capacity.
  const markers = ['config-service.js', ...(limits.maxBytes > 8 * MiB ? ['log-retention-config.mjs'] : [])];
  const message = 'The selected release/image could not be verified to support YAML configuration or this log capacity. Use an updated release/image; YAML-aware releases without expanded log capacity require explicit diagnostics.maxBytes of 8 MiB or less; no fallback was applied';
  try {
    if (p.meta.runtime === 'native') {
      for (const marker of markers) if (!(await lstat(join(resolve(p.meta.release), 'apps/server/dist', marker))).isFile()) throw Error('Capability marker missing');
    } else {
      const probe = `import {accessSync} from 'node:fs'; for (const marker of ${JSON.stringify(markers)}) accessSync('/app/apps/server/dist/'+marker);`;
      await run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'node', p.meta.image, '--input-type=module', '-e', probe], { capture: true, timeoutMs: 15000 });
    }
  } catch { throw Error(message); }
}
export async function setDevLogRetentionDefaults(p) {
  if (p.profile !== 'dev') throw Error('log-retention --defaults is only available for the dev profile');
  const before = effectiveLogRetention(p), document = structuredClone(p.document);
  delete document.diagnostics.maxBytes;
  await assertLogRetentionCompatible({ ...p, document });
  const changed = Object.hasOwn(p.savedDocument.diagnostics ?? {}, 'maxBytes');
  if (changed) await updateProfileConfiguration(p, next => { delete next.diagnostics.maxBytes; });
  const after = effectiveLogRetention(p);
  const summary = limits => ({ maxFileMiB: limits.logMaxMiB, maxFiles: limits.logMaxFiles });
  return { profile: p.profile, changed, before: summary(before), after: summary(after), restartRequired: true };
}
export function isolatedEnvironment(p, extra = {}) {
  const env = { ...process.env }, secretEnv = configSecretEnvironment(p.savedDocument ?? {}, env);
  for (const key of Object.keys(env)) if (key.startsWith('MOTE_') || key.startsWith('COMPOSE_') || key.startsWith('TUNNEL_') || key.startsWith('CLOUDFLARED_') || key === 'NO_AUTOUPDATE') delete env[key];
  const result = { ...env, ...secretEnv, NODE_USE_ENV_PROXY: '1', NODE_ENV: p.profile === 'prod' ? 'production' : p.profile === 'test' ? 'test' : 'development',
    MOTE_CONFIG_FILE: p.configFile, MOTE_PROFILE: p.profile, MOTE_URL: p.url, MOTE_TOKEN: p.env.MOTE_TOKEN, ...extra };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    const lower = name.toLowerCase(), value = result[lower] || result[name];
    if (value !== undefined || result[lower] !== undefined) result[name] = result[lower] = value ?? '';
  }
  const bypass = [...new Set([result.NO_PROXY, result.no_proxy, '127.0.0.1,localhost,::1,[::1]'].filter(Boolean).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))].join(',');
  result.NO_PROXY = result.no_proxy = bypass;
  return result;
}
export function execute(command, args, { env, cwd = repository, capture = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '', outputBytes = 0, timedOut = false, outputExceeded = false;
    let killTimer;
    const terminate = () => { if (killTimer) return; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      const remaining = Math.max(0, 4 * 1024 * 1024 - outputBytes), length = Math.min(chunk.length, remaining);
      if (length) { output += chunk.subarray(0, length).toString('utf8'); outputBytes += length; }
      if (chunk.length > remaining) { outputExceeded = true; terminate(); }
    });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); if (code === 0 && !timedOut && !outputExceeded) resolvePromise(output.trim()); else reject(Error(`${command} ${args[0] ?? ''} ${outputExceeded ? 'exceeded output limit' : timedOut ? 'timed out' : `exited ${code}`}${capture ? '; diagnostic output suppressed to avoid exposing configuration' : ''}`)); });
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
    const pid = Number((await readFile(join(record.dataDir || p.dataDir, 'server.pid'), 'utf8')).trim());
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
export async function startNative(p, foreground = false, options = {}) {
  await assertLogRetentionCompatible(p);
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
  const entry = options.entry ?? join(resolve(p.meta.release), 'apps/server/dist/index.js');
  await stat(entry).catch(() => { throw Error('Central build is missing. Run npm ci, build:libs, and build server/web in the selected release'); });
  await ensurePortFree(p);
  const marker = randomUUID(); await mkdir(join(p.directory, 'logs'), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [join(repository, 'scripts/central-runner.mjs'), entry, join(resolve(p.directory, p.env.MOTE_LOG_DIR || 'logs'), 'central.log'), `--mote-instance=${marker}`], { cwd: resolve(p.meta.release), env: isolatedEnvironment(p, options.env), detached: !foreground, stdio: foreground ? 'inherit' : 'ignore' });
  let failure; child.once('error', error => { failure = error; });
  const exited = new Promise(resolvePromise => child.once('close', (code, signal) => resolvePromise({ code, signal })));
  if (!child.pid) throw Error('Could not start central process');
  const record = { pid: child.pid, marker, configurationFile: p.configFile, dataDir: p.dataDir, release: p.meta.release, startedAt: new Date().toISOString() };
  try { await atomicJson(p.processFile, record); } catch (error) { child.kill('SIGTERM'); throw error; }
  const deadline = Date.now() + 20000;
  while (!(await health(p))) {
    if (failure || child.exitCode !== null || child.signalCode !== null) throw Error(`Central exited during startup; inspect ${join(resolve(p.directory, p.env.MOTE_LOG_DIR || 'logs'), 'central.log')}`);
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
  return isolatedEnvironment(p, { MOTE_COMPOSE_PROJECT: p.project, MOTE_IMAGE: p.meta.image, MOTE_VOLUME: p.meta.volume, MOTE_MODELS_VOLUME: p.meta.modelsVolume || p.meta.volume+'-models', MOTE_MODELS_DIRECTORY: dockerModelDirectory(p.document),
    MOTE_PORT: String(p.port), MOTE_CONFIG_DIRECTORY: p.directory, MOTE_CONTAINER_USER: p.configUser || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    MOTE_DOCKER_ENV_FILE: join(p.directory, 'generated/secrets.env'), MOTE_BIND_ADDRESS: '127.0.0.1',
    MOTE_TLS_DOMAIN: p.env.MOTE_TLS_DOMAIN, MOTE_TLS_HTTP_PORT: p.env.MOTE_TLS_HTTP_PORT, MOTE_TLS_HTTPS_PORT: p.env.MOTE_TLS_HTTPS_PORT,
    MOTE_TUNNEL_IMAGE: validateTunnel(p.meta.tunnel).image, MOTE_TUNNEL_PROTOCOL: validateTunnel(p.meta.tunnel).protocol, MOTE_TUNNEL_TOKEN_FILE: tunnelTokenPath(p), MOTE_TUNNEL_USER: p.tunnelUser || `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}` });
}
export function composeArgs(p, args) {
  return ['compose', '--project-name', p.project, '--project-directory', repository, '--env-file', join(repository, 'deploy/empty.env'), '-f', join(repository, 'compose.yaml'), ...(p.meta.tls ? ['-f', join(repository, 'compose.tls.yaml')] : []), ...(validateTunnel(p.meta.tunnel).enabled ? ['-f', join(repository, 'compose.tunnel.yaml')] : []), ...args];
}
export function composeOperation(args) {
  const valueOptions = new Set(['--project-name', '-p', '--file', '-f', '--project-directory', '--env-file', '--profile', '--parallel', '--ansi', '--progress']);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') return args[index + 1];
    if (!value.startsWith('-')) return value;
    if (valueOptions.has(value)) index++;
  }
  return undefined;
}
export async function dockerConfigurationUser(p, run = execute) {
  const file = await lstat(p.configFile);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) throw Error('Docker YAML must be an owned private regular file (0600)');
  const endpoint = process.env.DOCKER_CONTEXT
    ? JSON.parse(await run('docker', ['context', 'inspect', process.env.DOCKER_CONTEXT, '--format', '{{json .Endpoints.docker.Host}}'], { capture: true }))
    : process.env.DOCKER_HOST || JSON.parse(await run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { capture: true }));
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw Error('YAML bind mounts require a local Unix Docker engine; run this CLI on the Docker host');
  const security = JSON.parse(await run('docker', ['info', '--format', '{{json .SecurityOptions}}'], { capture: true }));
  if (!Array.isArray(security) || security.some(value => typeof value !== 'string')) throw Error('Cannot determine Docker YAML ownership');
  const rootless = security.includes('name=rootless');
  if (!rootless && security.some(value => value === 'name=userns' || value.startsWith('name=userns,'))) throw Error('Docker userns-remap YAML mounts are unsupported; use a local engine with verified private file permissions');
  return rootless ? '0:0' : `${file.uid}:${file.gid}`;
}
export async function compose(p, args, options = {}) {
  const operation = composeOperation(args);
  if (['up', 'create', 'run', 'restart'].includes(operation)) await assertLogRetentionCompatible(p);
  const tunnel = validateTunnel(p.meta.tunnel);
  if (['up', 'create', 'run', 'restart'].includes(operation)) p.configUser = await dockerConfigurationUser(p);
  if (tunnel.enabled && ['up','create','run','restart'].includes(operation)) { await assertTunnelToken(p); p.tunnelUser = await dockerTunnelUser(p, execute); }
  else if (operation === 'up' && p.meta.tunnel) await removeTunnelSidecars(p, execute);
  // The mounted YAML remains authoritative. Only referenced secrets cross env_file.
  const lines = Object.entries(configSecretEnvironment(p.savedDocument)).map(([key, value]) => { if (/[\r\n]/.test(value)) throw Error('Docker secret values must be single-line'); return `${key}=${value}`; });
  const file = join(p.directory, 'generated/secrets.env'), temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
  return execute('docker', composeArgs(p, args), { env: composeEnvironment(p), ...options });
}
export async function migrateStorageOwner(p, dependencies = {}) {
  if (p.meta.runtime !== 'docker') throw Error('migrate-storage-owner requires a Docker profile');
  const run = dependencies.execute ?? execute, composeRun = dependencies.compose ?? compose;
  p.configUser = await (dependencies.configurationUser ?? dockerConfigurationUser)(p, run);
  const volumes = [p.meta.volume, p.meta.modelsVolume || p.meta.volume + '-models'];
  for (const volume of volumes) {
    await run('docker', ['volume', 'inspect', volume], { capture: true });
    const running = await run('docker', ['ps', '--filter', `volume=${volume}`, '--format', '{{.ID}}'], { capture: true });
    if (running.trim()) throw Error('Stop every container using this profile data or model volume before migrating storage ownership');
  }
  await composeRun(p, ['run', '--rm', '--no-deps', 'storage-init', 'node', 'scripts/storage-owner-entry.mjs', '--migrate', p.configUser, '/data', p.modelDirectory], { capture: true });
  return { migrated: true, profile: p.profile, owner: p.configUser, started: false };
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
  if (manifest.storageEpoch !== 5) throw Error('Unsupported backup storage epoch; restore older backups with their matching older binary');
  for (const [name, hash] of Object.entries(manifest.checksums)) {
    const part=/^files\/objects\/[a-f0-9]{64}\/(0|[1-9][0-9]{0,2})(?:\.plain|\.aes)$/.exec(name);
    const sourceBatch=/^source-archive\/[a-f0-9]{64}\/[a-f0-9]{64}(?:\.plain|\.aes)$/.test(name);
    if (!(name === 'mote.sqlite' || sourceBatch || (part && Number(part[1]) < 128) || safePluginBackupPath(name)) || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Unsafe backup manifest entry');
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.nlink !== 1 || (await realpath(join(directory, name))) !== join(directory, name)) throw Error('Backup links are not allowed');
    if (await sha(join(directory, name)) !== hash) throw Error('Backup checksum mismatch; active data was not changed');
  }
  const db = new DatabaseSync(join(directory, 'mote.sqlite'), { readOnly: true });
  try {
    const settings=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!settings || db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value !== '5') throw Error('Unsupported backup database epoch; existing destination data was not changed');
  } finally { db.close(); }
  return { directory, names: Object.keys(manifest.checksums), checksums: manifest.checksums };
}
export async function restoreProfile(p, backup) {
  const checked = await verifiedBackup(backup);
  const stage = join(p.meta.runtime === 'native' ? dirname(p.dataDir) : p.directory, `.mote-restore-${randomUUID()}`); await mkdir(join(stage, 'blobs'), { recursive: true, mode: 0o700 });
  const createdNativeVolumes=[];let restored=false;
  try {
    for (const name of checked.names) {
      await mkdir(dirname(join(stage,name)),{recursive:true,mode:0o700});
      await copyFile(join(checked.directory, name), join(stage, name));
      await chmod(join(stage,name),0o600);
      if (await sha(join(stage, name)) !== checked.checksums[name]) throw Error('Backup changed while copying; active data was not changed');
    }
    for(const name of checked.names.filter(value=>value.endsWith('/hindsight-backup/manifest.json'))){
      const archiveDirectory=dirname(join(stage,name)),configurationDirectory=dirname(archiveDirectory);
      const result=await restoreHindsight({archiveDirectory,runtimeDirectory:join(configurationDirectory,'runtime'),providerDirectory:join(configurationDirectory,'provider')});
      createdNativeVolumes.push(result.volume);
      // This restores only storage. It starts no Central, API, model or worker.
      // A later explicit Central start retains the host's restored desired state
      // and prior task authorizations, subject to normal credential validation.
      await rm(archiveDirectory,{recursive:true});
    }
    if (p.meta.runtime === 'docker') {
      const existing = (await compose(p, ['ps', '--all', '--quiet', 'mote'], { capture: true })).trim();
      if (existing) await assertDockerStopped(p);
      await compose(p, ['create', '--no-build', 'mote'], { capture: true });
      const id = await assertDockerStopped(p);
      await compose(p, ['run', '--rm', '--no-deps', 'mote', 'node', '-e', "if(require('node:fs').readdirSync('/data').length)process.exit(2)"], { capture: true });
      await execute('docker', ['cp', `${stage}/.`, `${id}:/data`], { capture: true });
      await compose(p, ['run', '--rm', '--no-deps', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', 'mote', 'chown', '-R', p.configUser || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '/data'], { capture: true });
    } else {
      if ((await nativeIdentity(p)).running) throw Error('Stop this profile before restore');
      await assertVaultStopped(p.dataDir);
      await mkdir(p.dataDir, { recursive: true, mode: 0o700 });
      if ((await readdir(p.dataDir)).length) throw Error('Restore requires an empty data directory; existing data is never overwritten');
      await rmdir(p.dataDir); await rename(stage, p.dataDir);
    }
    restored=true;return { restored: true, source: checked.directory };
  } finally {
    if(!restored)for(const volume of createdNativeVolumes)await execute('docker',['volume','rm',volume],{capture:true}).catch(()=>{});
    await rm(stage, { recursive: true, force: true });
  }
}
export function launchdXml(p, nodePath = process.execPath) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const label = `dev.mote.central.${p.profile}.${p.project.split('-').at(-1)}`;
  const args = [resolve(nodePath), join(repository, 'scripts/mote.mjs'), 'run', '--profile', p.profile, '--home', p.home];
  const strings = args.map(value => `<string>${escape(value)}</string>`).join('');
  return { label, contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${strings}</array><key>WorkingDirectory</key><string>${escape(repository)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n` };
}

export async function updateProfileConfiguration(p, change) {
  const before = await readFile(p.configFile, 'utf8'), parsed = parseConfigDocument(before);
  const next = structuredClone(parsed.savedDocument); change(next);
  if (JSON.stringify(next) === JSON.stringify(parsed.savedDocument)) return;
  next.revision = parsed.savedDocument.revision + 1;
  const temp = `${p.configFile}.${randomUUID()}.tmp`;
  try {
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(serializeConfigDocument(next)); await fd.sync(); } finally { await fd.close(); }
    if (await readFile(p.configFile, 'utf8') !== before) throw Error('Configuration changed while updating; retry after reloading this profile');
    await rename(temp, p.configFile);
    const loaded = readConfigDocument(p.configFile); p.document = loaded.document; p.savedDocument = loaded.savedDocument; p.env = connectionValues(p.document, p.directory);
  } finally { await rm(temp, { force: true }); }
}
export async function setPublicUrl(p, url) { await updateProfileConfiguration(p, document => { document.server.publicUrl = url; }); }
