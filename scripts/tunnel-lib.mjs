// Cloudflare remotely-managed tunnel credentials never enter argv, environment or diagnostics.
import { constants } from 'node:fs';
import { open, mkdir, chmod, lstat, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
export const CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:2026.9.1';
export const TUNNEL_METRICS = '127.0.0.1:20241';
export const tunnelTokenPath = p => join(p.directory, 'secrets', 'cloudflared-token');
export function validateTunnel(value) {
  if (value === undefined) return { enabled: false, provider: 'cloudflare', protocol: 'auto', image: CLOUDFLARED_IMAGE };
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || value.provider !== 'cloudflare' || !['auto','http2','quic'].includes(value.protocol) || value.image !== CLOUDFLARED_IMAGE) throw Error('Invalid tunnel metadata; use the profile tunnel command');
  if (value.publicUrl) publicOrigin(value.publicUrl);
  if (value.binary && (typeof value.binary !== 'string' || !isAbsolute(value.binary) || /[\r\n\0]/.test(value.binary))) throw Error('Tunnel binary must be an absolute executable path');
  return value;
}
export function publicOrigin(value) {
  try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error(); return u.origin; }
  catch { throw Error('Tunnel public URL must be an HTTPS origin without credentials, path, query or fragment'); }
}
async function privateToken(path, content = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 16384 || (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) throw Error();
    if (!content) return metadata;
    const raw = (await file.readFile('utf8')).trim();
    if (raw.length < 32 || raw.length > 16384 || !/^[A-Za-z0-9_+/=-]+$/.test(raw)) throw Error();
    return raw;
  } catch { throw Error('Tunnel token file must be an owned regular private file (0600), 32–16384 characters; credential contents are suppressed'); }
  finally { await file?.close(); }
}
export async function assertTunnelToken(p) { return privateToken(tunnelTokenPath(p)); }
async function writeToken(p, source) {
  const token = await privateToken(resolve(source), true);
  const directory = join(p.directory, 'secrets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw Error('Tunnel secrets directory must be owned and cannot be a symlink');
  await chmod(directory, 0o700);
  const temp = join(directory, `.cloudflared-${randomUUID()}.tmp`);
  try { const fd = await open(temp, 'wx', 0o600); try { await fd.writeFile(token + '\n'); await fd.sync(); } finally { await fd.close(); } await rename(temp, tunnelTokenPath(p)); }
  finally { await rm(temp, { force: true }); }
}
/** Docker local file secrets retain host ownership; do not make the secret world-readable. */
export async function dockerTunnelUser(p, execute) {
  const token = await assertTunnelToken(p);
  const endpoint = process.env.DOCKER_CONTEXT
    ? JSON.parse(await execute('docker', ['context','inspect',process.env.DOCKER_CONTEXT,'--format','{{json .Endpoints.docker.Host}}'], { capture: true }))
    : process.env.DOCKER_HOST || JSON.parse(await execute('docker', ['context','inspect','--format','{{json .Endpoints.docker.Host}}'], { capture: true }));
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw Error('Tunnel file secrets require a local Unix Docker engine; run this CLI on the Docker host');
  const security = JSON.parse(await execute('docker', ['info','--format','{{json .SecurityOptions}}'], { capture: true }));
  if (!Array.isArray(security) || security.some(v => typeof v !== 'string')) throw Error('Cannot determine Docker file-secret ownership');
  const rootless = security.includes('name=rootless');
  if (!rootless && security.some(v => v === 'name=userns' || v.startsWith('name=userns,'))) throw Error('Docker userns-remap file secrets are not supported; use a local engine with verified secret permissions');
  return rootless ? '0:0' : `${token.uid}:${token.gid}`;
}
export async function removeTunnelSidecars(p, execute) {
  const output = await execute('docker', ['ps','--all','--filter',`label=com.docker.compose.project=${p.project}`,'--filter','label=com.docker.compose.service=cloudflared','--format','{{.ID}}'], { capture: true });
  const ids = output.trim().split(/\s+/).filter(Boolean);
  if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw Error('Invalid tunnel container identity; no container was stopped');
  if (ids.length) { await execute('docker', ['stop','--time','35',...ids], { capture: true, timeoutMs: 60000 }); await execute('docker', ['rm',...ids], { capture: true }); }
  return ids.length;
}
export async function configureTunnel(p, options, { execute, persist, persistPublicUrl }) {
  if (options.enable === options.disable) throw Error('tunnel requires exactly one of --enable / --disable');
  const previous = validateTunnel(p.meta.tunnel);
  if (options.disable) {
    // Do this even after a partly completed disable or rollback: orphaned connectors must not remain public.
    const removed = p.meta.runtime === 'docker' ? await removeTunnelSidecars(p, execute) : 0;
    const native = p.meta.runtime === 'native' ? await stopNativeTunnel(p) : {};
    p.meta.tunnel = { ...previous, enabled: false }; await persist(p.meta);
    return { configured: false, removedSidecars: removed, credentialRetained: true, ...native };
  }
  const next = { ...previous, enabled: true, provider: 'cloudflare', image: CLOUDFLARED_IMAGE,
    protocol: options.protocol ?? previous.protocol,  ...(options.binary ? { binary: resolve(options.binary) } : {}) };
  validateTunnel(next);
  if (p.meta.runtime === 'native' && !next.binary) throw Error('Native tunnel requires --binary with an installed absolute cloudflared executable (2025.4.0+)');
  if (options.binary && !isAbsolute(options.binary)) throw Error('--binary must be an absolute executable path');
  if (options['public-url'] || p.env.MOTE_PUBLIC_URL) publicOrigin(options['public-url'] || p.env.MOTE_PUBLIC_URL);
  if (options['token-file']) await privateToken(resolve(options['token-file']), true); else await assertTunnelToken(p);
  // A rotated connector must stop before replacing its credential, including mounted old inodes.
  if (p.meta.runtime === 'docker') await removeTunnelSidecars(p, execute);
  if (options['token-file']) await writeToken(p, options['token-file']);
  if (options['public-url']) { const url = publicOrigin(options['public-url']); await persistPublicUrl(url); p.env.MOTE_PUBLIC_URL = url; }
  delete next.publicUrl; p.meta.tunnel = next; await persist(p.meta);
  return { configured: true, connected: 'not-checked', originService: p.meta.runtime === 'docker' ? 'http://mote:47832' : p.url,
    publicUrl: p.env.MOTE_PUBLIC_URL || null, protocol: next.protocol, metrics: p.meta.runtime === 'docker' ? TUNNEL_METRICS : '127.0.0.1:0',
    applyWith: p.meta.runtime === 'docker' ? 'start (pulls the pinned cloudflared image if missing)' : 'tunnel-run (foreground, externally supervised)',
    dashboardRequired: 'Configure the published hostname and origin service in Cloudflare; this command does not configure DNS or account routing' };
}
export function nativeTunnelArgs(p) {
  const tunnel = validateTunnel(p.meta.tunnel);
  if (!tunnel.enabled || !tunnel.binary) throw Error('Configure and enable this native tunnel first');
  return ['tunnel','--config',join(p.directory,'generated/cloudflared-empty.yml'),'--no-autoupdate','--protocol',tunnel.protocol,'--metrics','127.0.0.1:0','--loglevel','warn','--grace-period','30s','run','--token-file',tunnelTokenPath(p)];
}
const nativeStatePath = p => join(p.directory, 'tunnel-process.json');
async function readNativeState(p) {
  try {
    const v = JSON.parse(await readFile(nativeStatePath(p),'utf8'));
    if (!v || !/^[a-f0-9-]{36}$/.test(v.marker) || !Number.isSafeInteger(v.pid) || v.pid < 1 || !Number.isSafeInteger(v.childPid) || v.childPid < 1) throw Error();
    return v;
  } catch (error) { if (error.code === 'ENOENT') return; throw Error('Invalid native tunnel process record; stop manually before repair'); }
}
function childIdentity(record) {
  try { process.kill(record.childPid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const result = spawnSync('ps',['-p',String(record.childPid),'-o','stat=','-o','args='],{encoding:'utf8'});
  if (/^\s*Z/.test(result.stdout)) return false;
  if (result.status !== 0 || !new RegExp(`(?:^|\\s)--tag\\s+mote-instance=${record.marker}(?:\\s|$)`).test(result.stdout)) throw Error('Tunnel PID identity cannot be verified; no unrelated process was signalled');
  return true;
}
export async function nativeTunnelIdentity(p) {
  const record = await readNativeState(p);
  if (!record) return { running: false, managed: false, connected: 'not-checked', externalConnectorState: 'unknown' };
  const running = childIdentity(record);
  return { running, managed: running, connected: 'not-checked', externalConnectorState: 'unknown' };
}
function wrapperIdentity(record) {
  try { process.kill(record.pid,0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const result = spawnSync('ps',['-p',String(record.pid),'-o','stat=','-o','args='],{encoding:'utf8'});
  return result.status === 0 && !/^\s*Z/.test(result.stdout) && new RegExp(`(?:^|\\s)mote-tunnel-run ${record.marker}(?:\\s|$)`).test(result.stdout);
}
async function clearNativeState(p, marker) { if ((await readNativeState(p))?.marker === marker) await rm(nativeStatePath(p),{force:true}); }
export async function stopNativeTunnel(p) {
  const record = await readNativeState(p);
  if (!record) return { managedConnector: false, externalConnectorState: 'unknown', externalStopRequired: true };
  if (childIdentity(record)) {
    // The live wrapper owns the single stop signal; if it died, stop only the tagged child.
    process.kill(wrapperIdentity(record) ? record.pid : record.childPid,'SIGTERM');
  }
  const deadline = Date.now() + 40000;
  while (childIdentity(record)) { if (Date.now() > deadline) throw Error('Native tunnel shutdown not confirmed; configuration is disabled, no forced kill was sent'); await sleep(100); }
  await clearNativeState(p,record.marker);
  return { managedConnector: true, stopped: true, externalConnectorState: 'unknown' };
}
export async function runNativeTunnel(p) {
  try { p.meta = JSON.parse(await readFile(p.metaFile,'utf8')); }
  catch { throw Error('Native tunnel configuration could not be read; contents are suppressed'); }
  if (!validateTunnel(p.meta.tunnel).enabled) return { wait: async () => ({ stopped: true, configured: false }) };
  const initialToken = await assertTunnelToken(p); const args = nativeTunnelArgs(p), binary = p.meta.tunnel.binary;
  if (!(await stat(binary)).isFile()) throw Error('Installed cloudflared binary is unavailable');
  const existing = await readNativeState(p);
  if (existing) {
    if (childIdentity(existing)) {
      if (wrapperIdentity(existing)) throw Error('This profile already has a running connector');
      // A supervisor killed with SIGKILL can be restarted safely without duplicating its orphan connector.
      await stopNativeTunnel(p);
    } else await clearNativeState(p,existing.marker);
  }
  const marker = randomUUID(); args.splice(args.indexOf('run'),0,'--tag',`mote-instance=${marker}`);
  const config = join(p.directory,'generated/cloudflared-empty.yml'), configTemp = `${config}.${randomUUID()}.tmp`;
  try { const fd = await open(configTemp,'wx',0o600); try { await fd.writeFile('{}\n'); await fd.sync(); } finally { await fd.close(); } await rename(configTemp,config); }
  finally { await rm(configTemp,{force:true}); }
  const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(k => process.env[k] !== undefined).map(k => [k,process.env[k]]));
  const child = spawn(binary,args,{env,stdio:'ignore'});
  const exited = new Promise((resolvePromise,reject) => { child.once('error',() => reject(Error('Could not start cloudflared; details suppressed'))); child.once('exit',(code,signal) => resolvePromise({code,signal})); });
  // Register rejection handling before filesystem work, then publish only verified child identity.
  void exited.catch(() => undefined);
  if (!child.pid) return exited;
  const record = { pid:process.pid, childPid:child.pid, marker };
  const originalTitle = process.title; process.title = `mote-tunnel-run ${marker}`;
  let state, ownsState = false;
  try { state = await open(nativeStatePath(p),'wx',0o600); ownsState = true; await state.writeFile(JSON.stringify(record)); await state.sync(); await state.close(); state = undefined; }
  catch { process.title = originalTitle; await state?.close().catch(() => undefined); child.kill('SIGTERM'); await exited.catch(() => undefined); if (ownsState) await rm(nativeStatePath(p),{force:true}); throw Error('Could not own native tunnel process record; connector was stopped'); }
  let configurationStopped = false, requestedStop = false, checking = false;
  const signature = JSON.stringify(p.meta.tunnel);
  const requestStop = signal => { if (requestedStop) return; requestedStop = true; clearInterval(timer); child.kill(signal); };
  const timer = setInterval(() => { if (checking || requestedStop) return; checking = true; void (async () => {
    try {
      const next = JSON.parse(await readFile(p.metaFile,'utf8')), token = await stat(tunnelTokenPath(p));
      if (JSON.stringify(next.tunnel) === signature && token.ino === initialToken.ino && token.mtimeMs === initialToken.mtimeMs) return;
    } catch { /* Loss of configuration/credential access closes the connector. */ }
    configurationStopped = true; requestStop('SIGTERM');
  })().finally(() => { checking = false; }); },1000);
  const onInt = () => requestStop('SIGINT'), onTerm = () => requestStop('SIGTERM');
  process.on('SIGINT',onInt); process.on('SIGTERM',onTerm);
  return { wait: async () => { try {
    const result = await exited;
    if ((result.code !== 0 || result.signal) && !requestedStop) throw Error('cloudflared exited unsuccessfully; check installed version, token-file permissions and Cloudflare routing');
    return { stopped:true, configurationChanged:configurationStopped };
  } finally { process.title = originalTitle; clearInterval(timer); process.off('SIGINT',onInt); process.off('SIGTERM',onTerm); await clearNativeState(p,marker); } } };
}
