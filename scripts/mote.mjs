#!/usr/bin/env node
// Explicit profiles only. Ambient MOTE_* variables never choose a target or supply credentials.
import { parseArgs } from 'node:util';
import { writeFile, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profilePaths, initialize, loadProfile, isolatedEnvironment, withProfileLock, startNative, stopNative, nativeIdentity, health, compose, execute, dockerContainer, backupProfile, restoreProfile, verifiedBackup, atomicJson, launchdXml, effectiveConfiguration, setPublicUrl } from './profile-lib.mjs';
import { configureTunnel, runNativeTunnel, nativeTunnelArgs, nativeTunnelIdentity } from './tunnel-lib.mjs';
const help = `Mote central profiles (Node 24+, default: dev; prod requires --profile prod)
  init [--profile dev|test|prod] [--home PATH] [--runtime native|docker] [--port N] [--image TAG] [--data-dir NATIVE_PATH | --volume DOCKER_VOLUME]
  start|run|stop|status|config|token [--profile NAME] [--home PATH]
  exec [--profile NAME] [--home PATH] -- COMMAND ARG...
  compose [--profile NAME] [--home PATH] -- build|ps|...
  backup [--profile NAME] [--home PATH] [--out NEW_DIRECTORY]
  restore --from BACKUP [--profile NAME] [--home PATH]
  launchd [--profile NAME] [--home PATH] [--node ABSOLUTE_NODE]
  tunnel --enable --token-file PRIVATE_FILE [--public-url HTTPS_ORIGIN] [--protocol auto|http2|quic] [--binary ABSOLUTE_CLOUDFLARED]
  tunnel --disable [--profile NAME] [--home PATH]
  tunnel-run|tunnel-launchd [--profile NAME] [--home PATH] [--node ABSOLUTE_NODE]
  tls --enable|--disable [--profile NAME] [--home PATH]
  upgrade --release BUILT_CHECKOUT | --image LOCAL_IMAGE [--profile NAME] [--home PATH]
  rollback --restore-data [--profile NAME] [--home PATH]
Prefix commands with: node scripts/mote.mjs
No command installs launchd, publishes images, deletes old volumes or changes the legacy root .env.
Tunnel tokens are accepted only through private files, never argument values or environment.
Native tunnel-run is foreground; generated launchd services are never installed automatically.
Only token intentionally prints a central credential. Backups exclude credentials and encryption keys.`;
const split = process.argv.indexOf('--');
const raw = process.argv.slice(2, split < 0 ? undefined : split);
const tail = split < 0 ? [] : process.argv.slice(split + 1);
let values, positionals;
try { ({ values, positionals } = parseArgs({ args: raw, allowPositionals: true, options: {
  profile: { type: 'string', default: 'dev' }, home: { type: 'string' }, runtime: { type: 'string' }, port: { type: 'string' }, image: { type: 'string' }, release: { type: 'string' },
  'data-dir': { type: 'string' }, volume: { type: 'string' }, 'token-file': { type: 'string' }, 'public-url': { type: 'string' }, protocol: { type: 'string' }, binary: { type: 'string' },
  out: { type: 'string' }, from: { type: 'string' }, node: { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' }, 'restore-data': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} })); } catch { console.error('Mote: Invalid arguments; use --help. Credentials are never accepted as argument values.'); process.exit(1); }
const command = positionals[0] ?? 'help';
const print = value => console.info(JSON.stringify(value));
async function stop(p) { return p.meta.runtime === 'docker' ? compose(p, ['stop'], { capture: true }).then(() => ({ stopped: true })) : stopNative(p); }
async function start(p) { return p.meta.runtime === 'docker' ? compose(p, ['up', '--detach', '--no-build', '--wait'], { timeoutMs: 120000 }).then(() => ({ started: true, project: p.project, url: p.url })) : startNative(p); }
async function deploymentChange(p, rollback) {
  if (rollback && (!values['restore-data'] || !p.meta.previous?.backup)) throw Error('Rollback restores the pre-upgrade snapshot and preserves current data separately. Review profile.json previous.backup, then use --restore-data');
  let next;
  if (rollback) { next = p.meta.previous; await verifiedBackup(next.backup); }
  else if (p.meta.runtime === 'native') {
    if (!values.release) throw Error('Native upgrade requires --release pointing to a separately built, immutable checkout');
    if (resolve(values.release) === resolve(p.meta.release)) throw Error('Use a separate release directory so the previous code remains available for rollback');
    await stat(join(resolve(values.release), 'apps/server/dist/index.js')); next = { release: resolve(values.release) };
  } else {
    if (!values.image) throw Error('Docker upgrade requires --image; build or pull it first');
    next = { image: await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', values.image], { capture: true }) };
  }
  if (p.meta.runtime === 'docker') p.meta.image = await execute('docker', ['inspect', '--format', '{{.Image}}', await dockerContainer(p)], { capture: true });
  await stop(p);
  const backup = await backupProfile(p, join(p.directory, 'backups', `${rollback ? 'pre-rollback' : 'pre-upgrade'}-${Date.now()}-${randomUUID().slice(0, 8)}`));
  const previous = { ...p.meta, backup }; delete previous.previous;
  let rollbackVolume;
  if (rollback) {
    if (p.meta.runtime === 'native') {
      const archivedData = `${p.dataDir}.before-rollback-${Date.now()}`;
      await rename(p.dataDir, archivedData); print({ preservedData: archivedData });
    } else {
      await compose(p, ['down'], { capture: true }); // No --volumes: preserve the upgraded data volume.
      rollbackVolume = `${p.project}-rollback-${Date.now()}`;
    }
  }
  p.meta = { ...p.meta, ...next, tunnel: p.meta.tunnel, previous, ...(rollbackVolume ? { volume: rollbackVolume } : {}) };
  delete p.meta.backup;
  await atomicJson(p.metaFile, p.meta);
  if (rollback) await restoreProfile(p, next.backup);
  // Failure leaves the snapshot intact; never run old code on possibly migrated data automatically.
  return { ...await start(p), snapshot: backup };
}
async function main() {
  if (values.help || command === 'help') { console.info(help); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer is required');
  if (positionals.length > 1) throw Error('Unexpected arguments; use -- before exec/compose arguments');
  const paths = profilePaths(values.profile, values.home);
  if (command === 'init') { print(await initialize(paths, values)); return; }
  const p = await loadProfile(paths);
  if (command === 'config') { print(effectiveConfiguration(p)); return; }
  if (command === 'tunnel') {
    print(await withProfileLock(p, () => configureTunnel(p, values, { execute, persist: meta => atomicJson(p.metaFile, meta), persistPublicUrl: url => setPublicUrl(p,url) }))); return;
  }
  if (command === 'tunnel-run') {
    if (p.meta.runtime !== 'native') throw Error('Use start for Docker tunnel profiles');
    const runner = await withProfileLock(p, () => runNativeTunnel(p));
    if (!runner?.wait) throw Error('Native tunnel could not start');
    print(await runner.wait()); return;
  }
  if (command === 'tunnel-launchd') {
    if (p.meta.runtime !== 'native') throw Error('tunnel-launchd requires a native profile');
    nativeTunnelArgs(p);
    const original = launchdXml(p,values.node), label = original.label.replace('dev.mote.central.','dev.mote.tunnel.');
    const contents = original.contents.replaceAll(original.label,label).replace('<string>run</string>','<string>tunnel-run</string>');
    const path = join(p.directory,'generated',`${label}.plist`); await writeFile(path,contents,{mode:0o600});
    print({ generated:path,label,installed:false,credentialInArguments:false }); return;
  }
  if (command === 'token') { console.info(p.env.MOTE_TOKEN); return; }
  if (command === 'status') {
    const state = p.meta.runtime === 'native' ? await nativeIdentity(p) : { compose: await compose(p, ['ps', '--all', '--format', 'json'], { capture: true }) };
    print({ profile: p.profile, runtime: p.meta.runtime, envFile: p.envFile, dataDir: p.meta.runtime === 'native' ? p.dataDir : p.meta.volume, port: p.port, url: p.url, healthy: await health(p), tunnel: { ...effectiveConfiguration(p).tunnel, ...(p.meta.runtime === 'native' ? await nativeTunnelIdentity(p) : {}) }, ...state }); return;
  }
  if (command === 'exec') {
    if (!tail.length) throw Error('exec requires -- COMMAND ARG...');
    await execute(tail[0], tail.slice(1), { env: isolatedEnvironment(p), timeoutMs: 24 * 60 * 60 * 1000 }); return;
  }
  if (command === 'compose') {
    if (p.meta.runtime !== 'docker' || !tail.length) throw Error('compose requires a Docker profile and -- SUBCOMMAND ARG...');
    await withProfileLock(p, () => compose(p, tail, { timeoutMs: 20 * 60 * 1000 })); return;
  }
  if (command === 'launchd') {
    if (p.meta.runtime !== 'native') throw Error('launchd requires a native profile');
    const { label, contents } = launchdXml(p, values.node);
    const path = join(p.directory, 'generated', `${label}.plist`); await writeFile(path, contents, { mode: 0o600 });
    print({ generated: path, label, installed: false, envFile: p.envFile }); return;
  }
  if (command === 'tls') {
    if (p.meta.runtime !== 'docker' || values.enable === values.disable) throw Error('tls requires a Docker profile and exactly one of --enable / --disable');
    p.meta.tls = Boolean(values.enable);
    if (p.meta.tls && !/^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/i.test(p.env.MOTE_TLS_DOMAIN ?? '')) throw Error('Set MOTE_TLS_DOMAIN in this private profile first');
    await withProfileLock(p, () => atomicJson(p.metaFile, p.meta)); print({ tls: p.meta.tls, applyWith: `start --profile ${p.profile}` }); return;
  }
  let result;
  await withProfileLock(p, async () => {
    if (command === 'start') result = await start(p);
    else if (command === 'run') { if (p.meta.runtime !== 'native') throw Error('Use start for a Docker profile'); result = await startNative(p, true); }
    else if (command === 'stop') result = await stop(p);
    else if (command === 'backup') result = { backup: await backupProfile(p, values.out) };
    else if (command === 'restore') { if (!values.from) throw Error('restore requires --from BACKUP'); result = await restoreProfile(p, values.from); }
    else if (command === 'upgrade' || command === 'rollback') result = await deploymentChange(p, command === 'rollback');
    else throw Error('Unknown command; use --help');
  });
  if (result?.wait) { const finished = await result.wait(); process.exitCode = finished.code ?? 1; }
  else print({ profile: p.profile, ...result });
}
main().catch(error => { console.error(`Mote: ${error.message}`); process.exitCode = 1; });
