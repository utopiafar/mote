/** Opt-in macOS import test launcher. No model calls, credentials, or production defaults. */
import {mkdir,realpath,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const quote=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
const ancestors=(path:string)=>{const values:string[]=[];for(let value=dirname(path);;value=dirname(value)){values.push(value);if(value===dirname(value))return values;}};

export type PrivateImportLaunch={dshBin:string;profilePath:string;runtimeRoot:string;workspace:string;network:'denied'|'loopback-relay';relayPort?:number;readOnlyPaths:string[]};

/** The caller supplies this run's unique Harness root; never pass the owner's home/data directory. */
export async function preparePrivateImportLaunch(input:{workspace:string;runtimeRoot:string;relayPort?:number}):Promise<PrivateImportLaunch>{
  if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'))throw Error('This test launcher requires macOS sandbox-exec');
  const workspace=await realpath(input.workspace),runtimeRoot=await realpath(input.runtimeRoot),nodeBinary=await realpath(process.execPath);
  assert.notEqual(workspace,runtimeRoot,'Use separate selected-input and runtime directories');
  if(input.relayPort!==undefined)assert.ok(Number.isInteger(input.relayPort)&&input.relayPort>0&&input.relayPort<=65535,'Relay port must be a valid explicit TCP port');
  const dependencies=await realpath(join(repository,'node_modules'));
  const serverDependencies=await realpath(join(repository,'apps/server/node_modules'));
  const compiled=await realpath(join(repository,'packages/shared/dist'));
  const sharedManifest=await realpath(join(repository,'packages/shared/package.json'));
  const dshManifest=JSON.parse(await readFile(new URL('../node_modules/@deepseek-ai/dsh/package.json',import.meta.url),'utf8')) as {bin:{dsh:string}};
  const realDsh=join(dependencies,'@deepseek-ai/dsh',dshManifest.bin.dsh);
  const directories=[workspace,runtimeRoot,dependencies,serverDependencies,compiled,'/System/Library','/System/Volumes/Preboot/Cryptexes/OS','/usr/lib','/usr/share/locale','/usr/share/zoneinfo','/private/var/db/timezone','/bin','/usr/bin'];
  const files=[nodeBinary,sharedManifest,'/dev/null','/dev/random','/dev/urandom','/dev/tty','/private/etc/localtime'];
  const metadata=[...new Set([...directories,...files].flatMap(ancestors))];
  const profile=[
    '(version 1)',
    '(deny default)',
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    '(allow syscall* mach-bootstrap)',
    '(allow process-exec process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(deny sysctl-read (sysctl-name "kern.procargs" "kern.procargs2"))',
    '(allow mach-lookup)',
    `(allow file-read* ${directories.map(path=>`(subpath ${quote(path)})`).join(' ')} ${files.map(path=>`(literal ${quote(path)})`).join(' ')})`,
    `(allow file-map-executable ${directories.map(path=>`(subpath ${quote(path)})`).join(' ')} (literal ${quote(nodeBinary)}))`,
    `(allow file-read-metadata ${metadata.map(path=>`(literal ${quote(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(runtimeRoot)}) (literal "/dev/null"))`,
    '(allow file-read* file-write* file-ioctl (regex #"^/dev/(ttys[0-9]+|ptmx|tty|fd/[0-9]+)$"))',
    '(allow pseudo-tty)',
    ...(input.relayPort===undefined?[]:[`(allow network-outbound (remote tcp "localhost:${input.relayPort}"))`]),
    // No network, arbitrary home, checkout source, or other archive grants.
  ].join('\n')+'\n';
  const profilePath=join(runtimeRoot,'private-import.sb'),dshBin=join(runtimeRoot,'private-import-launch.mjs');
  await mkdir(join(runtimeRoot,'home'),{recursive:true,mode:0o700});
  await mkdir(join(runtimeRoot,'tmp'),{recursive:true,mode:0o700});
  await writeFile(profilePath,profile,{mode:0o600});
  // execve keeps the SDK's process handle attached to the sandboxed runtime;
  // there is no unsandboxed wrapper parent or orphaned nested Harness on close.
  await writeFile(dshBin,`import process from 'node:process';
if(typeof process.execve!=='function')throw Error('A Node runtime with POSIX execve is required');
const environment={...process.env,HOME:${JSON.stringify(join(runtimeRoot,'home'))},TMPDIR:${JSON.stringify(join(runtimeRoot,'tmp'))}};
process.execve('/usr/bin/sandbox-exec',['/usr/bin/sandbox-exec','-f',${JSON.stringify(profilePath)},${JSON.stringify(nodeBinary)},${JSON.stringify(realDsh)},...process.argv.slice(2)],environment);
`,{mode:0o600});
  return {dshBin,profilePath,runtimeRoot,workspace,network:input.relayPort===undefined?'denied':'loopback-relay',relayPort:input.relayPort,readOnlyPaths:[dependencies,serverDependencies,compiled,sharedManifest,nodeBinary]};
}

async function boundedProcess(command:string,args:string[],cwd:string){
  return await new Promise<{status:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolvePromise,reject)=>{
    const child=spawn(command,args,{cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd,TMPDIR:cwd},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';const timeout=setTimeout(()=>child.kill('SIGKILL'),30000);
    child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>64000)child.kill('SIGKILL');});
    child.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>64000)child.kill('SIGKILL');});
    child.on('error',reject);child.on('close',(status,signal)=>{clearTimeout(timeout);resolvePromise({status,signal,stdout,stderr});});
  });
}

async function selfTest(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'mote-private-import-proof-'))),workspace=join(root,'selected'),runtimeRoot=join(root,'runtime'),other=join(root,'other-job');
  await Promise.all([workspace,runtimeRoot,other].map(path=>mkdir(path,{mode:0o700})));
  const outsideCanary=join(repository,'scripts/fixtures',`private-import-canary-${randomUUID()}.txt`),ownerEnvCanary=join(other,'owner.env');
  await writeFile(outsideCanary,'GENERATED_CHECKOUT_CANARY',{mode:0o600});await writeFile(ownerEnvCanary,'GENERATED_FAKE_CREDENTIAL=fixture-only\n',{mode:0o600});
  await writeFile(join(workspace,'selected.txt'),'GENERATED_SELECTED_INPUT',{mode:0o600});
  const launch=await preparePrivateImportLaunch({workspace,runtimeRoot});
  try{
    const basic=await boundedProcess('/usr/bin/sandbox-exec',['-f',launch.profilePath,'/bin/echo','generated-sandbox'],workspace);
    assert.equal(basic.status,0,JSON.stringify({basic}));
    const probePath=join(workspace,'probe.mjs');
    const sdkUrl=import.meta.resolve('@deepseek-ai/dsh-sdk-client'),sharedUrl=pathToFileURL(join(repository,'packages/shared/dist/index.js')).href;
    await writeFile(probePath,`import assert from 'node:assert/strict';import{readFile,writeFile,symlink}from'node:fs/promises';import{spawnSync}from'node:child_process';
assert.equal(await readFile('selected.txt','utf8'),'GENERATED_SELECTED_INPUT');
await import(${JSON.stringify(sdkUrl)});await import(${JSON.stringify(sharedUrl)});
for(const path of ${JSON.stringify([outsideCanary,ownerEnvCanary,join(repository,'apps/server/src/app.ts')])}){let denied=false;try{await readFile(path);}catch(error){denied=['EPERM','EACCES'].includes(error.code);}assert.ok(denied,'Read must be denied: '+path);}
await symlink(${JSON.stringify(ownerEnvCanary)},'escape-link');let linkDenied=false;try{await readFile('escape-link');}catch(error){linkDenied=['EPERM','EACCES'].includes(error.code);}assert.ok(linkDenied,'Symlink escape must be denied');
let writeDenied=false;try{await writeFile(${JSON.stringify(join(other,'forbidden-write'))},'generated');}catch(error){writeDenied=['EPERM','EACCES'].includes(error.code);}assert.ok(writeDenied,'Sibling write must be denied');
await writeFile('allowed-output.txt','generated');await writeFile(${JSON.stringify(join(runtimeRoot,'allowed-runtime.txt'))},'generated');
const shell=spawnSync('/bin/bash',['--noprofile','--norc','-c','printf generated-shell'],{encoding:'utf8'});assert.equal(shell.status,0,shell.stderr);assert.equal(shell.stdout,'generated-shell');
console.log(JSON.stringify({selectedRead:true,dependencyImports:true,checkoutCanaryDenied:true,ownerEnvCanaryDenied:true,sourceDenied:true,symlinkEscapeDenied:true,siblingWriteDenied:true,selectedWrite:true,runtimeWrite:true,nativeShell:true}));
`,{mode:0o600});
    const probe=await boundedProcess('/usr/bin/sandbox-exec',['-f',launch.profilePath,process.execPath,probePath],workspace);
    assert.equal(probe.status,0,JSON.stringify(probe));
    const proof=JSON.parse(probe.stdout.trim());
    const harness=new DeepSeekHarness({dshBin:launch.dshBin,profile:'sdk-minimal',dshHome:join(runtimeRoot,'home'),cwd:workspace,processCwd:workspace,initializeTimeoutMs:20000,env:{PATH:'/usr/bin:/bin',HOME:join(runtimeRoot,'home'),TMPDIR:join(runtimeRoot,'tmp')}});
    let initialized=false;try{await harness.start();initialized=true;}finally{await harness.close();}
    const hits=[0,0],servers=hits.map((_,index)=>createServer((_req,res)=>{hits[index]++;res.end('generated-relay');}));
    try{
      await Promise.all(servers.map(server=>new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen))));
      const ports=servers.map(server=>(server.address() as {port:number}).port),networkProbe=join(workspace,'network-probe.mjs');
      const writeNetworkProbe=async(allowed:boolean)=>writeFile(networkProbe,`import assert from 'node:assert/strict';
const addresses=${JSON.stringify(ports)};
for(let index=0;index<addresses.length;index++){try{const response=await fetch('http://127.0.0.1:'+addresses[index],{signal:AbortSignal.timeout(2000)});assert.ok(${allowed}&&index===0,'Unexpected network access');assert.equal(await response.text(),'generated-relay');}catch(error){if(${allowed}&&index===0)throw error;assert.ok(['EPERM','EACCES'].includes(error.cause?.code),'Expected OS denial, got '+error);}}
console.log('generated-network-proof');`,{mode:0o600});
      await writeNetworkProbe(false);const denied=await boundedProcess('/usr/bin/sandbox-exec',['-f',launch.profilePath,process.execPath,networkProbe],workspace);assert.equal(denied.status,0,JSON.stringify(denied));
      await preparePrivateImportLaunch({workspace,runtimeRoot,relayPort:ports[0]});
      await writeNetworkProbe(true);const selective=await boundedProcess('/usr/bin/sandbox-exec',['-f',launch.profilePath,process.execPath,networkProbe],workspace);assert.equal(selective.status,0,JSON.stringify(selective));
      assert.deepEqual(hits,[1,0]);proof.defaultNetworkDenied=true;proof.exactRelayAllowed=true;proof.otherLocalPortDenied=true;
    }finally{await Promise.all(servers.map(server=>new Promise<void>(resolveClose=>{server.closeAllConnections();server.close(()=>resolveClose());})));}
    const report={syntheticOnly:true,modelCalls:0,credentialsLoaded:false,network:'only-generated-relay-tested',proof,sdkInitialize:initialized,sdkClose:true,profilePath:launch.profilePath};
    const reportPath=join(root,'report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({reportPath,...report},null,2));
  }finally{await rm(outsideCanary,{force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.ok(process.argv.includes('--self-test'),'Only --self-test is supported; it never loads keys or calls a model.');
  await selfTest();
}
