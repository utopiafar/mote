#!/usr/bin/env node
// Explicit profiles only. Ambient MOTE_* variables never choose a target or supply credentials.
import { parseArgs } from 'node:util';
import { writeFile,readFile,mkdir,stat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import { profilePaths, initialize, loadProfile, isolatedEnvironment, withProfileLock, startNative, nativeIdentity, health, compose, execute, backupProfile, restoreProfile, atomicJson, launchdXml, effectiveConfiguration, setPublicUrl } from './profile-lib.mjs';
import { configureTunnel, runNativeTunnel, nativeTunnelArgs, nativeTunnelIdentity, stopNativeTunnel } from './tunnel-lib.mjs';
import { startProfile as start, stopProfile as stop, changeProfileDeployment } from './update-deploy.mjs';
const help = `Mote central profiles (Node 24+, default: dev; prod requires --profile prod)
  init [--profile dev|test|prod] [--home PATH] [--runtime native|docker] [--port N] [--image TAG] [--data-dir NATIVE_PATH | --volume DOCKER_VOLUME]
  start|run|stop|status|config|token [--profile NAME] [--home PATH]
  run-all [--profile NAME] [--home PATH] (native central + configured tunnel; Ctrl+C stops both)
  exec [--profile NAME] [--home PATH] -- COMMAND ARG...
  compose [--profile NAME] [--home PATH] -- build|ps|...
  backup [--profile NAME] [--home PATH] [--out NEW_DIRECTORY]
  restore --from BACKUP [--profile NAME] [--home PATH]
  launchd [--profile NAME] [--home PATH] [--node ABSOLUTE_NODE]
  media-runtime [--profile NAME] [--home PATH] [--python PYTHON_BINARY] (Native profile, stopped)
  media-import --role ocr|dialogue --from DIRECTORY [--profile NAME] [--home PATH] (verified offline model bundle)
  tunnel --enable --token-file PRIVATE_FILE [--public-url HTTPS_ORIGIN] [--protocol auto|http2|quic] [--binary ABSOLUTE_CLOUDFLARED]
  tunnel --disable [--profile NAME] [--home PATH]
  tunnel-run|tunnel-launchd [--profile NAME] [--home PATH] [--node ABSOLUTE_NODE]
  tls --enable|--disable [--profile NAME] [--home PATH]
  upgrade --release BUILT_CHECKOUT | --image LOCAL_IMAGE [--profile NAME] [--home PATH]
  check-update [--profile NAME] [--home PATH] [--version VERSION]
  update [--profile NAME] [--home PATH] [--version VERSION]
  rollback --restore-data [--profile NAME] [--home PATH]
Prefix commands with: node scripts/mote.mjs
No command installs launchd, publishes images, deletes old volumes or changes the legacy root .env.
Tunnel tokens are accepted only through private files, never argument values or environment.
Native tunnel-run is foreground; generated launchd services are never installed automatically.
Only token intentionally prints a central credential. Backups exclude credentials and encryption keys.
When encryption has been used, preserve MOTE_DATA_KEY or the vault content-key file separately for restore.`;
const split = process.argv.indexOf('--');
const raw = process.argv.slice(2, split < 0 ? undefined : split);
const tail = split < 0 ? [] : process.argv.slice(split + 1);
let values, positionals;
try { ({ values, positionals } = parseArgs({ args: raw, allowPositionals: true, options: {
  profile: { type: 'string', default: 'dev' }, home: { type: 'string' }, runtime: { type: 'string' }, port: { type: 'string' }, image: { type: 'string' }, release: { type: 'string' }, version: { type: 'string' },
  'data-dir': { type: 'string' }, volume: { type: 'string' }, 'token-file': { type: 'string' }, 'public-url': { type: 'string' }, protocol: { type: 'string' }, binary: { type: 'string' },
  out: { type: 'string' }, from: { type: 'string' }, role:{type:'string'}, node: { type: 'string' }, python: {type:'string'}, enable: { type: 'boolean' }, disable: { type: 'boolean' }, 'restore-data': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} })); } catch { console.error('Mote: Invalid arguments; use --help. Credentials are never accepted as argument values.'); process.exit(1); }
const command = positionals[0] ?? 'help';
const print = value => console.info(JSON.stringify(value));
async function main() {
  if (values.help || command === 'help') { console.info(help); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer is required');
  if (positionals.length > 1) throw Error('Unexpected arguments; use -- before exec/compose arguments');
  const paths = profilePaths(values.profile, values.home);
  if (command === 'init') { print(await initialize(paths, values)); return; }
  const p = await loadProfile(paths);
  if (command === 'run-all') {
    if (p.meta.runtime !== 'native') throw Error('run-all requires a native profile');
    let central, tunnel, centralWait, tunnelWait;
    let interrupted = false;
    const onSignal = () => { interrupted = true; };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    try {
      await withProfileLock(p, async () => {
        if ((await nativeIdentity(p)).running || (await nativeTunnelIdentity(p)).running)
          throw Error('Stop the existing central and tunnel before run-all; this command only owns new processes');
        await configureTunnel(p, { enable: true }, { execute, persist: meta => atomicJson(p.metaFile, meta), persistPublicUrl: url => setPublicUrl(p, url) });
        if (interrupted) return;
        central = await startNative(p, true);
        centralWait = central.wait();
        if (interrupted) return;
        tunnel = await runNativeTunnel(p);
        tunnelWait = tunnel.wait();
        // Attach rejection handling before releasing the profile lock.
        void tunnelWait.catch(() => undefined);
      });
      if (!interrupted && centralWait && tunnelWait) {
        console.info(`Mote ${p.profile}: central ${p.url} + Tunnel running. Ctrl+C stops both.`);
        const result = await Promise.race([centralWait, tunnelWait]);
        if (!interrupted) process.exitCode = result?.code ?? 1;
      }
    } finally {
      try {
        await Promise.all([central ? stop(p) : undefined, tunnel ? stopNativeTunnel(p) : undefined]);
        await Promise.allSettled([centralWait, tunnelWait]);
      } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
    }
    return;
  }
  if (command === 'config') { print(effectiveConfiguration(p)); return; }
  if (command === 'media-runtime') {
    if (p.meta.runtime !== 'native') throw Error('Docker bundles the media runtime in its image');
    const result=await withProfileLock(p,async()=>{
      if((await nativeIdentity(p)).running)throw Error('Stop this profile before installing the Native media runtime');
      const requirements=['requirements-audio.txt','requirements-ocr.txt'].map(name=>fileURLToPath(new URL(name,import.meta.url)));
      const hash=createHash('sha256');for(const path of requirements)hash.update(await readFile(path));const version=hash.digest('hex');
      const root=join(p.directory,'media-venv'),marker=join(root,'mote-requirements.sha256');
      if(await readFile(marker,'utf8').catch(()=>null)===version)return {profile:p.profile,installed:true,changed:false,python:join(root,'bin/python')};
      await mkdir(p.directory,{recursive:true,mode:0o700});
      await execute(values.python||'python3',['-m','venv',root],{env:isolatedEnvironment(p),timeoutMs:120000});
      await execute(join(root,'bin/python'),['-m','pip','install','--disable-pip-version-check','--no-cache-dir',...requirements.flatMap(path=>['-r',path])],{env:isolatedEnvironment(p),timeoutMs:30*60*1000});
      await writeFile(marker,version,{mode:0o600});return {profile:p.profile,installed:true,changed:true,python:join(root,'bin/python')};
    });print(result);return;
  }
  if (command === 'media-import') {
    if(!['ocr','dialogue'].includes(values.role)||!values.from)throw Error('media-import requires --role ocr|dialogue and --from DIRECTORY');
    const source=resolve(values.from),info=await stat(source);if(!info.isDirectory())throw Error('Model source must be a directory');
    await withProfileLock(p,async()=>{
      if(p.meta.runtime==='native'){
        const script=fileURLToPath(new URL('media-import.mjs',import.meta.url));
        await execute(process.execPath,[script,join(p.directory,'models'),values.role,source],{env:isolatedEnvironment(p),timeoutMs:10*60*1000});
      }else{
        if(/[,:]/.test(source))throw Error('Docker model import source path cannot contain comma or colon');
        await execute('docker',['run','--rm','--network','none','--mount',`type=volume,source=${p.meta.volume}-models,target=/models`,'--mount',`type=bind,source=${source},target=/import,readonly`,p.meta.image,'node','scripts/media-import.mjs','/models',values.role,'/import'],{env:isolatedEnvironment(p),timeoutMs:10*60*1000});
      }
    });return;
  }
  if (command === 'check-update') {
    const { checkProfileUpdate } = await import('./update-release.mjs');
    const checked = await checkProfileUpdate(p, { version: values.version });
    print({ profile: p.profile, currentVersion: checked.currentVersion, latestVersion: checked.manifest.version, available: checked.available, verified: true, channel: checked.manifest.channel, releaseUrl: checked.manifest.notesUrl, runtime: p.meta.runtime }); return;
  }
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
    else if (command === 'update') {
      const { checkProfileUpdate, prepareProfileUpdate } = await import('./update-release.mjs');
      const checked = await checkProfileUpdate(p, { version: values.version });
      if (!checked.available) result = { updated: false, reason: 'already_current_or_newer', currentVersion: checked.currentVersion, latestVersion: checked.manifest.version };
      else {
        const prepared = await prepareProfileUpdate(p, checked, { onStage: phase => print({ profile: p.profile, version: checked.manifest.version, phase }) });
        print({ profile: p.profile, version: checked.manifest.version, phase: 'backup-and-switch' });
        result = { ...await changeProfileDeployment(p, { prepared }), updated: true, version: checked.manifest.version };
      }
    }
    else if (command === 'upgrade' || command === 'rollback') result = await changeProfileDeployment(p, { rollback: command === 'rollback', restoreData: values['restore-data'], release: values.release, image: values.image });
    else throw Error('Unknown command; use --help');
  });
  if (result?.wait) { const finished = await result.wait(); process.exitCode = finished.code ?? 1; }
  else print({ profile: p.profile, ...result });
}
main().catch(error => { console.error(`Mote: ${error.message}`); process.exitCode = 1; });
