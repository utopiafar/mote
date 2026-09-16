/** Opt-in macOS import test launcher. No model calls, credentials, or production defaults. */
import {mkdir,realpath,writeFile,readFile,mkdtemp,rm,readdir,chmod} from 'node:fs/promises';
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
  // macOS temp paths may enter the SDK as /var/... while realpath returns
  // /private/var/.... Its DSH_HOME and generated plugin imports keep that spelling.
  // Authorize both names of these same selected directories, never their parents.
  const writableRoots=[...new Set([workspace,runtimeRoot,resolve(input.workspace),resolve(input.runtimeRoot)])];
  const directories=[...writableRoots,dependencies,serverDependencies,compiled,'/System/Library','/System/Volumes/Preboot/Cryptexes/OS','/usr/lib','/usr/share/locale','/usr/share/zoneinfo','/private/var/db/timezone','/bin','/usr/bin'];
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
    `(allow file-write* ${writableRoots.map(path=>`(subpath ${quote(path)})`).join(' ')} (literal "/dev/null"))`,
    '(allow file-read* file-write* file-ioctl (regex #"^/dev/(ttys[0-9]+|ptmx|tty|fd/[0-9]+)$"))',
    '(allow pseudo-tty)',
    ...(input.relayPort===undefined?[]:[`(allow network-outbound (remote tcp "localhost:${input.relayPort}"))`]),
    // No network, arbitrary home, checkout source, or other archive grants.
  ].join('\n')+'\n';
  const profilePath=join(runtimeRoot,'private-import.sb'),dshBin=join(runtimeRoot,'private-import-launch.mjs');
  await mkdir(join(runtimeRoot,'home'),{recursive:true,mode:0o700});
  await mkdir(join(runtimeRoot,'tmp'),{recursive:true,mode:0o700});
  await writeFile(profilePath,profile,{mode:0o600});
  // The native macOS subprocess inspector hardcodes /bin/ps, whose setuid bit
  // makes sandbox-exec reject execution. A private non-setuid copy with a local
  // ad-hoc signature stays inside this same sandbox; argument/environment reads
  // stay denied. The original binary and installed vendor files are untouched.
  const privatePs=join(runtimeRoot,'private-ps'),loaderPath=join(runtimeRoot,'private-import-loader.mjs');
  await writeFile(privatePs,await readFile('/bin/ps'),{mode:0o700});await chmod(privatePs,0o700);
  const signed=await boundedProcess('/usr/bin/codesign',['--force','--sign','-',privatePs],runtimeRoot);
  assert.equal(signed.status,0,'Unable to ad-hoc sign the private non-setuid process inspector');
  const subprocessLib=dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local')));
  const inspectorFiles=(await readdir(subprocessLib)).filter(name=>/^runner-launch-[\w-]+\.js$/.test(name));
  assert.equal(inspectorFiles.length,1,'Expected the pinned native subprocess inspector bundle');
  const inspectorUrl=pathToFileURL(join(subprocessLib,inspectorFiles[0])).href;
  await writeFile(loaderPath,`import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(url!==${JSON.stringify(inspectorUrl)})return result;
const source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
if(source.split('"/bin/ps"').length!==3)throw Error('Pinned native process inspector changed');
return {...result,source:source.replaceAll('"/bin/ps"',${JSON.stringify(JSON.stringify(privatePs))})};}});
`,{mode:0o600});
  // execve keeps the SDK's process handle attached to the sandboxed runtime;
  // there is no unsandboxed wrapper parent or orphaned nested Harness on close.
  await writeFile(dshBin,`import process from 'node:process';
if(typeof process.execve!=='function')throw Error('A Node runtime with POSIX execve is required');
const environment={...process.env,HOME:${JSON.stringify(join(runtimeRoot,'home'))},TMPDIR:${JSON.stringify(join(runtimeRoot,'tmp'))}};
process.execve('/usr/bin/sandbox-exec',['/usr/bin/sandbox-exec','-f',${JSON.stringify(profilePath)},${JSON.stringify(nodeBinary)},'--import',${JSON.stringify(loaderPath)},${JSON.stringify(realDsh)},...process.argv.slice(2)],environment);
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

/** Exercise the actual import plugins and portable parser against a local scripted provider. */
async function nativeImportProof(workspace:string,outsideCanary:string,ownerEnvCanary:string){
  const {createImportAgent}=await import('@mote/agent');
  const {prepareImportInput}=await import('../apps/server/src/import-runtime.js');
  const inputPath='generated-input.yaml',text='合成资料：计划尚未完成。';
  await writeFile(join(workspace,inputPath),`id: generated-record\ntext: ${text}\n`,{mode:0o600});
  const input=prepareImportInput({workspace,inputPaths:[inputPath],instruction:'Only generated parser and sandbox proof.'});
  const converter=`import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {extractFile,validateRecords} from './mote-files.mjs';
const decoded=await extractFile(${JSON.stringify(inputPath)});assert.equal(decoded.status,'parsed');
assert.equal(decoded.data.text,${JSON.stringify(text)});
for(const path of ${JSON.stringify([outsideCanary,ownerEnvCanary,join(repository,'apps/server/src/app.ts')])})await assert.rejects(readFile(path),error=>['EPERM','EACCES'].includes(error.code));
const item={externalId:decoded.data.id,revision:'generated-v1',observedAt:'2026-09-16T00:00:00Z',title:'生成测试',text:decoded.data.text,kind:'file',layer:'original',document:{contentRole:'authored'}};
await writeFile('records.jsonl',JSON.stringify({item,evidencePaths:[${JSON.stringify(inputPath)}]})+'\\n');
assert.equal((await validateRecords('records.jsonl')).valid,true);
await writeFile('dispositions.json',JSON.stringify({items:[{path:${JSON.stringify(inputPath)},status:'parsed',reason:'generated proof'}]}));
console.log('GENERATED_RESTRICTED_MANIFEST_VALID');`;
  const requests:{tools?:{function:{name:string}}[];messages?:{role:string;content:unknown}[]}[]=[],errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const request=JSON.parse(raw);requests.push(request);
      assert.equal(req.headers.authorization,'Bearer generated-only');
      assert.equal(request.model,'fixture-model');
      assert.ok(['/chat/completions','/v1/chat/completions'].includes(req.url??''));
      const scriptCommand="'"+process.execPath.replaceAll("'","'\\''")+"' generated-convert.mjs";
      const calls=[{name:'skill',args:{name:'document-import'}},{name:'read',args:{file_path:join(workspace,inputPath)}},{name:'write',args:{file_path:join(workspace,'generated-convert.mjs'),content:converter}},{name:'bash',args:{command:scriptCommand}},{name:'read',args:{file_path:join(workspace,'records.jsonl')}}];
      const tool=calls[requests.length-1];
      const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'generated-'+requests.length,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content:JSON.stringify({summary:'已验证一条合成资料。',recordsPath:'records.jsonl',warnings:[]})};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({id:'generated',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({id:'generated',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
    }catch(error){errors.push(error);res.writeHead(500).end('Generated provider assertion failed');}
  });
  await new Promise<void>((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  const port=(server.address() as {port:number}).port;
  let runtimeAliasTested=false;
  const agent=createImportAgent({model:'fixture-model',apiKey:'generated-only',baseUrl:`http://127.0.0.1:${port}`,timeoutMs:60000},async paths=>{
    const launch=await preparePrivateImportLaunch({...paths,relayPort:port});
    runtimeAliasTested=resolve(paths.runtimeRoot)!==launch.runtimeRoot;
    return launch;
  });
  const observed:string[]=[];
  try{
    const result=await agent.prepare(input,event=>{if(event.method==='session.event'&&event.params&&typeof event.params.event==='object'&&event.params.event&&'type' in event.params.event)observed.push(String(event.params.event.type));});
    assert.deepEqual(errors,[]);assert.equal(requests.length,6);assert.equal(result.recordsPath,'records.jsonl');
    for(const name of ['skill','read','write','bash'])assert.ok(requests[0].tools?.some(tool=>tool.function.name===name));
    assert.ok(!requests[0].tools?.some(tool=>tool.function.name==='search_context'));
    const toolResults=requests.at(-1)?.messages?.filter(message=>message.role==='tool')??[];
    assert.ok(existsSync(join(workspace,'records.jsonl')),JSON.stringify(toolResults.slice(-2)));
    assert.ok(JSON.stringify(toolResults).includes('GENERATED_RESTRICTED_MANIFEST_VALID'));
    assert.equal(JSON.parse((await readFile(join(workspace,'records.jsonl'),'utf8')).trim()).item.text,text);
    assert.ok(observed.includes('tool/call'));assert.ok(observed.includes('tool/result'));
    return {mockRequests:requests.length,nativeSkillReadWriteShell:true,portableYamlParser:true,validatedManifest:true,checkoutAndSiblingDenied:true,runtimeAliasTested};
  }finally{
    await agent.close();server.closeAllConnections();await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));
  }
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
    const nativeImport=await nativeImportProof(workspace,outsideCanary,ownerEnvCanary);
    const report={syntheticOnly:true,modelCalls:0,credentialsLoaded:false,network:'only-generated-relay-tested',proof,nativeImport,sdkInitialize:initialized,sdkClose:true,profilePath:launch.profilePath};
    const reportPath=join(root,'report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({reportPath,...report},null,2));
  }finally{await rm(outsideCanary,{force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.ok(process.argv.includes('--self-test'),'Only --self-test is supported; it never loads keys or calls a model.');
  await selfTest();
}
