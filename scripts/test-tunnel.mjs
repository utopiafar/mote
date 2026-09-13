#!/usr/bin/env node
// Offline synthetic credentials and local fixture executables; no Cloudflare account or network.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { initialize, profilePaths, loadProfile, atomicJson, setPublicUrl, isolatedEnvironment, composeArgs, composeEnvironment, effectiveConfiguration, repository } from './profile-lib.mjs';
import { CLOUDFLARED_IMAGE, configureTunnel, tunnelTokenPath, assertTunnelToken, dockerTunnelUser, nativeTunnelArgs, nativeTunnelIdentity, stopNativeTunnel } from './tunnel-lib.mjs';
import { cli, command, updateEnvironment } from './profile-fixtures.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mote-tunnel-fixture-')), home = join(directory,'profiles');
const synthetic = 'synthetic-invalid-token-' + randomUUID().replaceAll('-',''), source = join(directory,'input-private-token');
const children = [];
let p;
const reload = profile => loadProfile(profilePaths(profile,home));
const noSecrets = value => { assert.equal(JSON.stringify(value).includes(synthetic),false,'Fixture credential must never be returned'); };
const waitFor = async operation => { const until = Date.now()+12000; while (!await operation()) { if (Date.now()>until) throw Error('Synthetic process fixture timed out'); await sleep(40); } };
const configure = (profile, options, execute = async () => '') => configureTunnel(profile,options,{execute,persist: meta => atomicJson(profile.metaFile,meta),persistPublicUrl:url=>setPublicUrl(profile,url)});
try {
  await writeFile(source,synthetic+'\n',{mode:0o600});
  await initialize(profilePaths('dev',home)); await initialize(profilePaths('test',home),{runtime:'docker'});
  p = await reload('dev'); let docker = await reload('test');
  const external = join(directory,'disk with spaces # and $','vault');
  await initialize(profilePaths('prod',home),{'data-dir':external});
  const prod = await reload('prod'); assert.equal(prod.dataDir,external);
  assert.equal(effectiveConfiguration(prod).storage.source,external);
  const config = JSON.parse((await cli(home,'prod','config')).stdout); noSecrets(config);
  assert.equal(config.processEnvFile,prod.envFile); assert.equal(config.storage.mount,external);
  assert.equal(effectiveConfiguration(docker).processEnvFile,'/app/deploy/empty.env');
  assert.equal(effectiveConfiguration(docker).storage.source,docker.meta.volume);
  await assert.rejects(initialize(profilePaths('dev',join(directory,'escape')),{'data-dir':external}),/inside/);
  await assert.rejects(initialize(profilePaths('prod',join(directory,'wrong')),{'data-dir':external,runtime:'docker'}),/native/);
  await assert.rejects(initialize(profilePaths('dev',join(directory,'volume')),{runtime:'docker',volume:'formal-vault'}),/own profile/);
  await initialize(profilePaths('prod',join(directory,'volume')),{runtime:'docker',volume:'explicit-private-vault'});
  assert.equal((await loadProfile(profilePaths('prod',join(directory,'volume')))).meta.volume,'explicit-private-vault');
  const envOriginal = await readFile(p.envFile,'utf8');
  for (const entry of ['DOCKER_CONTEXT=remote','DOCKER_HOST=tcp://remote:2375','COMPOSE_FILE=elsewhere','TUNNEL_TOKEN=synthetic','CLOUDFLARED_CONFIG=elsewhere']) {
    await writeFile(p.envFile,envOriginal+'\n'+entry+'\n'); await assert.rejects(reload('dev'),/not allowed|belong/);
  }
  await writeFile(p.envFile,envOriginal);
  const metaOriginal = await readFile(p.metaFile,'utf8');
  await writeFile(p.metaFile,`{invalid ${synthetic}`);
  const malformed = await cli(home,'dev','config',[],{fail:true}); noSecrets(malformed);
  await writeFile(p.metaFile,metaOriginal);
  const argumentsError = await command(process.execPath,[join(repository,'scripts/mote.mjs'),'tunnel','--token',synthetic]); assert.notEqual(argumentsError.code,0); noSecrets(argumentsError);
  console.info('[tunnel] Explicit storage, offline configuration, private defaults and parse-error redaction passed');

  const report = join(directory,'child-report.json'), control = join(directory,'child-control.json'), binary = join(directory,'fixture-cloudflared');
  await writeFile(control,JSON.stringify({mode:'wait'}));
  await writeFile(binary,`#!${process.execPath}\nconst fs = require('node:fs');\nconst args=process.argv.slice(2), file=args[args.indexOf('--token-file')+1];\nconst control=${JSON.stringify(control)}, report=${JSON.stringify(report)};\nconst token=fs.readFileSync(file,'utf8').trim();\nconst state={args,tokenRead:token.length>32,providerVariables:Object.keys(process.env).filter(k=>/^(MOTE_|TUNNEL_|CLOUDFLARED_|NO_AUTOUPDATE)/.test(k)),signals:0};\nfs.writeFileSync(report,JSON.stringify(state));\nprocess.stdout.write(token); process.stderr.write(token);\nconst mode=JSON.parse(fs.readFileSync(control)).mode;\nif(mode==='fail') process.exit(42);\nprocess.on('SIGTERM',()=>{state.signals++;fs.writeFileSync(report,JSON.stringify(state));if(state.signals===1)setTimeout(()=>process.exit(0),mode==='slow'?2200:20);});\nprocess.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);\n`,{mode:0o700});
  // Invalid permissions, symbolic source, and malformed content never become durable credentials.
  await chmod(source,0o644); await assert.rejects(configure(p,{enable:true,'token-file':source,binary}),/private/); await chmod(source,0o600);
  const link=join(directory,'token-link'); await symlink(source,link); await assert.rejects(configure(p,{enable:true,'token-file':link,binary}),/private/);
  const bad=join(directory,'invalid-content'); await writeFile(bad,synthetic+'\nPRIVATE BODY',{mode:0o600}); await assert.rejects(configure(p,{enable:true,'token-file':bad,binary}),/suppressed/);
  const enabled=await configure(p,{enable:true,'token-file':source,binary,'public-url':'https://mote.synthetic.invalid',protocol:'http2'}); noSecrets(enabled);
  p=await reload('dev'); assert.equal((await stat(tunnelTokenPath(p))).mode&0o777,0o600); assert.equal(p.env.MOTE_PUBLIC_URL,'https://mote.synthetic.invalid');
  assert.equal(p.meta.tunnel.publicUrl,undefined); assert.equal(p.meta.tunnel.image,CLOUDFLARED_IMAGE);
  noSecrets(p.meta); noSecrets(nativeTunnelArgs(p)); noSecrets(effectiveConfiguration(p));
  p=await updateEnvironment(p,{MOTE_PUBLIC_URL:'https://edited.synthetic.invalid'});
  assert.equal(isolatedEnvironment(p).MOTE_PUBLIC_URL,'https://edited.synthetic.invalid');
  const publicEnv=await readFile(p.envFile,'utf8');
  await writeFile(p.envFile,publicEnv+'\nMOTE_PUBLIC_URL=https://last.synthetic.invalid\n');
  await assert.rejects(setPublicUrl(p,'https://new.synthetic.invalid'),/safely/);
  assert.equal(await readFile(p.envFile,'utf8'),publicEnv+'\nMOTE_PUBLIC_URL=https://last.synthetic.invalid\n');
  await writeFile(p.envFile,publicEnv);
  await assert.rejects(configure(p,{enable:true,protocol:'bad'}),/metadata/);
  await assert.rejects(configure(p,{enable:true,'public-url':'https://synthetic.invalid/?private=value'}),/HTTPS origin/);
  const launch=JSON.parse((await cli(home,'dev','tunnel-launchd')).stdout); const xml=await readFile(launch.generated,'utf8'); noSecrets(xml); assert.match(xml,/<string>tunnel-run<\/string>/); assert.equal(xml.includes('--token-file'),false);
  if(process.platform==='darwin') assert.equal((await command('plutil',['-lint',launch.generated])).code,0);
  console.info('[tunnel] Private token import, fixed parameters, authoritative public URL and launchd generation passed');

  const calls=[];
  await configure(docker,{enable:true,'token-file':source},async (name,args)=>{calls.push(args);return '';}); docker=await reload('test');
  const dockerEnv=composeEnvironment(docker); noSecrets(dockerEnv); assert.equal(dockerEnv.MOTE_TUNNEL_TOKEN_FILE,tunnelTokenPath(docker));
  assert.ok(composeArgs(docker,['config']).some(v=>v.endsWith('compose.tunnel.yaml')));
  const oldHost=process.env.DOCKER_HOST, oldContext=process.env.DOCKER_CONTEXT;
  try {
    delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT;
    const engine=security=>async(name,args)=>args[0]==='context'?JSON.stringify('unix:///synthetic/docker.sock'):JSON.stringify(security);
    const info=await assertTunnelToken(docker); assert.equal(await dockerTunnelUser(docker,engine([])),`${info.uid}:${info.gid}`);
    assert.equal(await dockerTunnelUser(docker,engine(['name=rootless'])),'0:0');
    await assert.rejects(dockerTunnelUser(docker,engine(['name=userns'])),/userns/);
    process.env.DOCKER_HOST='tcp://synthetic.invalid:2375'; await assert.rejects(dockerTunnelUser(docker,engine([])),/local Unix/);
    process.env.DOCKER_HOST='unix:///synthetic/local.sock'; process.env.DOCKER_CONTEXT='synthetic-remote';
    let inspected=false;
    await assert.rejects(dockerTunnelUser(docker,async(name,args)=>{assert.deepEqual(args.slice(0,3),['context','inspect','synthetic-remote']); inspected=true; return JSON.stringify('ssh://synthetic.invalid');}),/local Unix/); assert.equal(inspected,true);
  } finally { if(oldHost===undefined)delete process.env.DOCKER_HOST;else process.env.DOCKER_HOST=oldHost; if(oldContext===undefined)delete process.env.DOCKER_CONTEXT;else process.env.DOCKER_CONTEXT=oldContext; }
  calls.length=0;
  await assert.rejects(configure(docker,{disable:true},async(name,args)=>{calls.push(args);if(args[0]==='ps')return 'abcdef012345';throw Error('synthetic stop error');}),/synthetic stop error/);
  assert.equal((await reload('test')).meta.tunnel.enabled,true);
  const disabled=await configure(docker,{disable:true},async(name,args)=>{calls.push(args);return args[0]==='ps'?'abcdef012345':'';}); assert.equal(disabled.removedSidecars,1);
  assert.ok(calls.some(args=>args[0]==='rm'&&args[1]==='abcdef012345'));
  assert.ok(calls.filter(args=>args[0]==='ps').every(args=>args.includes(`label=com.docker.compose.project=${docker.project}`)));
  console.info('[tunnel] Docker target precedence, ownership, exact orphan removal and failed-stop state preservation passed');

  async function spawnRunner(mode='wait') {
    await rm(report,{force:true}); await writeFile(control,JSON.stringify({mode}));
    const child=spawn(process.execPath,[join(repository,'scripts/mote.mjs'),'tunnel-run','--profile','dev','--home',home],{stdio:['ignore','pipe','pipe'],env:{...process.env,TUNNEL_TOKEN:synthetic,CLOUDFLARED_CONFIG:'synthetic-hidden',MOTE_DEBUG:'1',NO_AUTOUPDATE:'false'}});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,get stdout(){return stdout},get stderr(){return stderr}}))); children.push(child);
    await waitFor(async()=>{try { return JSON.parse(await readFile(report,'utf8')).tokenRead; } catch { return false; }});
    await waitFor(async()=>{try { await stat(join(p.directory,'lifecycle.lock')); return false; } catch(error) { return error.code==='ENOENT'; }});
    return {child,done};
  }
  let runner=await spawnRunner();
  let observed=JSON.parse(await readFile(report,'utf8')); assert.deepEqual(observed.providerVariables,[]); noSecrets(observed);
  assert.equal(observed.args[observed.args.indexOf('--metrics')+1],'127.0.0.1:0'); assert.ok(observed.args.includes('--tag'));
  const runningStatus=JSON.parse((await cli(home,'dev','status')).stdout); assert.equal(runningStatus.tunnel.running,true); assert.equal(runningStatus.tunnel.managed,true); assert.equal(runningStatus.tunnel.connected,'not-checked');
  const duplicate=await cli(home,'dev','tunnel-run',[],{fail:true}); assert.match(duplicate.stderr,/already/);
  await cli(home,'dev','tunnel',['--disable']); let result=await runner.done; assert.equal(result.code,0); noSecrets(result); assert.equal((await nativeTunnelIdentity(p)).running,false);
  assert.equal(JSON.parse((await cli(home,'dev','tunnel-run')).stdout).configured,false,'Disabled launchd runner must exit successfully');
  p=await reload('dev'); await configure(p,{enable:true}); p=await reload('dev');
  runner=await spawnRunner(); runner.child.kill('SIGKILL'); await runner.done;
  assert.equal((await nativeTunnelIdentity(p)).running,true,'Orphan child remains identifiable after wrapper SIGKILL');
  // Recovery replaces only the tagged orphan, then resumes supervision.
  runner=await spawnRunner(); assert.equal((await nativeTunnelIdentity(p)).running,true);
  const interruptedStop=JSON.parse(await readFile(join(p.directory,'tunnel-process.json'),'utf8'));
  await atomicJson(join(p.directory,'tunnel-process.json'),{...interruptedStop,stopRequested:true});
  await cli(home,'dev','tunnel',['--disable']); assert.equal((await runner.done).code,0); assert.equal((await nativeTunnelIdentity(p)).running,false);
  p=await reload('dev'); await configure(p,{enable:true}); p=await reload('dev');
  runner=await spawnRunner(); const live=JSON.parse(await readFile(join(p.directory,'tunnel-process.json'),'utf8'));
  process.kill(live.childPid,'SIGKILL'); result=await runner.done; assert.notEqual(result.code,0); noSecrets(result);
  runner=await spawnRunner('fail'); result=await runner.done; assert.notEqual(result.code,0); noSecrets(result);
  runner=await spawnRunner('slow'); const changed=JSON.parse(await readFile(p.metaFile,'utf8')); changed.tunnel.protocol='quic'; await atomicJson(p.metaFile,changed);
  result=await runner.done; assert.equal(result.code,0); assert.equal(JSON.parse(await readFile(report,'utf8')).signals,1,'Configuration changes must not send a second signal during grace period'); noSecrets(result);
  p=await reload('dev'); runner=await spawnRunner('slow'); await rm(tunnelTokenPath(p));
  result=await runner.done; assert.equal(result.code,0); assert.equal(JSON.parse(await readFile(report,'utf8')).signals,1);
  await configure(p,{enable:true,'token-file':source});
  await atomicJson(join(p.directory,'tunnel-process.json'),{pid:process.pid,childPid:process.pid,marker:randomUUID()});
  await assert.rejects(stopNativeTunnel(p),/identity/); await rm(join(p.directory,'tunnel-process.json'));
  // Existing generated-file symlinks must be replaced, never followed.
  const sentinel=join(directory,'sentinel'); await writeFile(sentinel,'unchanged'); await rm(join(p.directory,'generated/cloudflared-empty.yml')); await symlink(sentinel,join(p.directory,'generated/cloudflared-empty.yml'));
  runner=await spawnRunner(); assert.equal(await readFile(sentinel,'utf8'),'unchanged'); runner.child.kill('SIGTERM'); result=await runner.done; assert.equal(result.code,0);
  console.info('[tunnel] Real local fixture process: running status, duplicate start, disable, orphan recovery, signal failure, one-shot grace and fail-closed config loss passed');
  console.info('[tunnel] No account credentials, Cloudflare connection, live model or personal captures were used');
} finally {
  if(p) await stopNativeTunnel(p).catch(()=>undefined);
  for(const child of children) if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await rm(directory,{recursive:true,force:true});
}
