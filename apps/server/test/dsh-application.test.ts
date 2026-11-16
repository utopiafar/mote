import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import fs,{existsSync,mkdirSync,readFileSync,renameSync,symlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8, zipSync} from 'fflate';
import {serializeConfigDocument} from '@mote/shared/config-file';
import type {RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {buildApp} from '../src/app.js';
import {configFromFile} from '../src/config.js';
import type {PluginManifest, PluginReleaseTransport} from '../src/plugin-release.js';
import {sha256} from '../src/store.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';
import {rejectSqliteWrites} from './fixtures/sqlite-writer.js';
import {resolveDependencies} from '../src/conversation-lineage.js';
import {readNativeFile} from '../src/dsh-application.js';
import {materialId} from '../src/materials.js';
import {Store} from '../src/store.js';
import sharp from 'sharp';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10));}
  assert.fail('Generated native pack did not settle: ' + label);
}

function generatedRelease(trace: string,hook?:string) {
  const repository = 'generated-fixture/native-dsh', tag = 'v1.0.0';
  const log = `import {appendFileSync} from 'node:fs';const trace=event=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,pid:process.pid})+'\\n');`;
  const archive = zipSync({
    'package.json': strToU8(JSON.stringify({name: '@mote/generated-installed-native', version: '1.0.0', type: 'module', exports: {'.': './index.mjs', './alias': './index.mjs', './hook': './hook.mjs', './factory': './factory.mjs'}, dsh: {native: {capabilities: ['hooks', 'factory', 'agents', 'mote.application.outputs']}}})),
    'index.mjs': strToU8(`${log}export const name='installed-native-package';export function apply(ctx){trace('package-loaded');ctx.effect(()=>()=>trace('package-disposed'));}`),
    'hook.mjs': strToU8(`${log}export const name='installed-native-hook';export function apply(ctx){trace('hook-loaded');ctx.on('agent/request',async(_,next)=>{const fs=await import('node:fs'),path=await import('node:path'),state=path.join(process.cwd(),'internal.json'),count=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')).count:0;fs.writeFileSync(state,JSON.stringify({count:count+1}));${hook??"fs.writeFileSync(path.join(process.cwd(),'status.json'),JSON.stringify({count:count+1}));fs.writeFileSync(path.join(process.cwd(),'report.txt'),'GENERATED-APPLICATION-REPORT-'+(count+1));"}trace('hook-request');return next();});ctx.effect(()=>()=>trace('hook-disposed'));}`),
    'factory.mjs': strToU8(`${log}import AgentLoop from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))};export const name='installed-native-factory';export const inject=['agents','sessions','sessionProjections','systemPrompt','tools','llm','sessionPersistence'];export function apply(ctx){class InstalledLoop extends AgentLoop{async createAgent(owner,options){trace('factory-create');return super.createAgent(owner,options);}async resume(owner,options){trace('factory-resume');return super.resume(owner,options);}}new InstalledLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>10}});ctx.effect(()=>()=>trace('factory-disposed'));}`),
  });
  const manifest: PluginManifest = {schemaVersion: 1, id: 'generated.installed-native', name: 'Generated original native DSH package', version: '1.0.0', runtime: 'service', entry: 'index.mjs', archive: {asset: 'native.zip', sha256: sha256(archive)}, capabilities: ['hooks', 'factory', 'agents', 'mote.application.outputs'], configuration: [], dependencies: [], access: ['Trusted native code selected explicitly by the owner'], contributions: [
    {id: 'generated.native-package', version: '1.0.0', surface: 'agent', runtime: 'native', entry: 'index.mjs'},
    {id: 'generated.native-hook', version: '1.0.0', surface: 'agent', runtime: 'native', entry: 'hook.mjs'},
    {id: 'generated.native-factory', version: '1.0.0', surface: 'agent', runtime: 'native', entry: 'factory.mjs'},
  ]};
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const transport: PluginReleaseTransport = async url => {
    if (url === `https://api.github.com/repos/${repository}/releases/tags/${tag}`) return {bytes: strToU8(JSON.stringify({tag_name: tag, draft: false, assets: ['mote-plugin.json', 'native.zip'].map(name => ({name, browser_download_url: base + name}))}))};
    if (url === `https://api.github.com/repos/${repository}/commits/${tag}`) return {bytes: strToU8(JSON.stringify({sha: 'a'.repeat(40)}))};
    if (url === base + 'mote-plugin.json') return {bytes: strToU8(JSON.stringify(manifest))};
    if (url === base + 'native.zip') return {bytes: archive};
    throw new Error('Unexpected generated release transport');
  };
  return {repository, tag, transport};
}

async function applicationFixture(t:TestContext,options:{hook?:string|((root:string)=>string);respond?:(request:any,response:ServerResponse,index:number)=>Promise<void>|void}={}) {
  const root=await mkdtemp(join(tmpdir(),'mote-installed-app-')),path=join(root,'mote.yaml'),trace=join(root,'native-trace.jsonl');
  const release=generatedRelease(trace,typeof options.hook==='function'?options.hook(root):options.hook),owner='generated-app-owner-'+randomUUID(),headers={authorization:'Bearer '+owner},requests:unknown[]=[];
  const model=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body);requests.push(request);if(options.respond)await options.respond(request,res,requests.length);else writeMessagesResponse(res,{stage:1,model:'generated-native-model',text:JSON.stringify({answer:'Generated application answer '+requests.length,citationIds:[]})});});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  await writeFile(path,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token:owner},storage:{dataDir:'vault',contentEncryptionEnabled:true},diagnostics:{level:'silent'},execution:{insightIntervalHours:0},models:{deployment:{provider:'deepseek',protocol:'deepseek',baseUrl:'http://127.0.0.1:'+(model.address() as {port:number}).port,model:'generated-native-model',apiKey:'generated-unused',maxTokens:1024,modelRequestTimeoutMs:10000,agentTimeoutMs:20000}}}));
  let node:Awaited<ReturnType<typeof buildApp>>|undefined;
  const open=async()=>{node=await buildApp(configFromFile(path),{backgroundWorker:false});Object.defineProperty(node.pluginCenter.releases,'transport',{value:release.transport});return node;};
  const restart=async()=>{await node?.app.close();return open();};
  t.after(async()=>{await node?.app.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  await open();
  const resolved=await node!.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:release.repository,tag:release.tag}});assert.equal(resolved.statusCode,200,resolved.body);
  const installed=await node!.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{previewId:resolved.json().id,expectedRevision:node!.pluginCenter.revision(),operationId:randomUUID()}});assert.equal(installed.statusCode,200,installed.body);
  await waitFor(()=>node!.pluginCenter.view().packages.some(pkg=>pkg.state==='installed'),'install');
  const packageId=node!.pluginCenter.view().packages.find(pkg=>pkg.state==='installed')!.id;
  const configured=await node!.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{packageId,name:'Generated native application',scope:'default',configuration:{},expectedRevision:node!.pluginCenter.revision(),operationId:randomUUID()}});assert.equal(configured.statusCode,200,configured.body);
  const instanceId=configured.json().id as string;
  const action=(name:'check'|'enable'|'disable')=>node!.app.inject({method:'POST',url:'/api/plugin-instances/'+instanceId+'/'+name,headers,payload:{expectedRevision:node!.pluginCenter.instanceView(instanceId).revision,operationId:randomUUID()}});
  assert.equal((await action('check')).statusCode,200);await waitFor(()=>node!.pluginCenter.instanceView(instanceId).observed==='ready','check');assert.equal((await action('enable')).statusCode,200);
  const directory=(await node!.app.inject({url:'/api/agent-runtime/native-modules',headers})).json().items as {reference:RuntimeModuleReference;requestedCapabilities:string[]}[];
  const modules=directory.filter(module=>module.reference.contribution.instance.instanceId===instanceId),byId=(id:string)=>modules.find(module=>module.reference.contribution.contributionId===id)!.reference,modelProfileId='native-app';
  assert.equal((await node!.app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:node!.configService.revision,value:{profiles:[{id:modelProfileId,name:'Generated application model',settings:node!.modelSettings.select('chat').settings}]}}})).statusCode,200);
  const profile={modelProfileId,assembly:{packages:[byId('generated.native-package')],hooks:[byId('generated.native-hook')],factory:byId('generated.native-factory')},grants:[{instance:modules[0]!.reference.contribution.instance,capabilities:modules[0]!.requestedCapabilities}],application:{instance:modules[0]!.reference.contribution.instance,session:'conversation',outputs:[{path:'status.json',mimeType:'application/json'},{path:'report.txt',mimeType:'text/plain'}]}};
  const save=await node!.app.inject({method:'PUT',url:'/api/configuration/dsh',headers,payload:{revision:node!.configService.revision,value:{profiles:[profile]}}});assert.equal(save.statusCode,200,save.body);await restart();
  const conversationId=(await node!.app.inject({url:'/api/conversations/main',headers})).json().id as string;
  const enqueue=async(question:string,extra:Record<string,unknown>={})=>{
    const response=await node!.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId,clientRequestId:randomUUID(),question,modelProfileId,scope:{kind:'all'},...extra}});assert.equal(response.statusCode,202,response.body);return response.json();
  };
  const settled=async(message:{id:string;conversationId:string})=>{
    let current:any;await waitFor(async()=>{current=(await node!.app.inject({url:'/api/conversations/'+message.conversationId+'/messages/'+message.id,headers})).json();return ['completed','failed','cancelled'].includes(current.status);},'native application message');return current;
  };
  const interact=async(question:string,extra:Record<string,unknown>={})=>settled(await enqueue(question,extra));
  const controlRows=()=>node!.store.db.prepare("SELECT key,json,revision FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/control'").all();
  return {root,path,trace,headers,requests,modelProfileId,profile,packageId,instanceId,conversationId,action,restart,enqueue,settled,interact,controlRows,get node(){return node!;}};
}

test('installed APP restores the original SDK session across interactions and Central restart, and publishes real Materials', {timeout:30000}, async t=>{
  const f=await applicationFixture(t);
  const legacy=await f.node.app.inject({method:'POST',url:'/api/query',headers:f.headers,payload:{question:'GENERATED-UNBOUND-APP-INPUT',modelProfileId:f.modelProfileId}});assert.equal(legacy.statusCode,409,legacy.body);assert.equal(f.requests.length,0,'an APP selection cannot silently use an unbound temporary native session');
  const first=await f.interact('FIRST-GENERATED-APP-INTERACTION');assert.equal(first.status,'completed',JSON.stringify({message:first,run:f.node.queryRuns.get(first.runId)}));
  const stateRows=f.controlRows;
  assert.equal(stateRows().length,1,'actual APP consumer must create a persistent bound control record');
  let control=JSON.parse(String(stateRows()[0]!.json));assert.ok(control.accepted);assert.equal(control.pending,undefined);assert.equal(control.writer,undefined);
  const privateRoot=join(f.root,'vault','native-applications',control.identity);assert.equal(existsSync(join(privateRoot,'working')),false,'idle SDK history is sealed with existing encryption');
  const manifest=join(privateRoot,'generations',control.accepted,'manifest');assert.equal(existsSync(manifest+'.aes'),true);assert.equal(existsSync(manifest+'.plain'),false);
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!;assert.ok(source);
  assert.equal(f.node.sources.getItem(source.id,'report.txt')!.text,'','source references must never carry derived body text');assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-1\n');
  await f.node.materialOrganizer.tick(20);
  const materials=f.node.materials.list({sourceId:source.id}).items;assert.equal(materials.length,2);
  const report=materials.find(material=>material.origin.externalId==='report.txt')!;
  assert.match(f.node.materials.read(report.ref,{offset:0,length:10000})!.text,/GENERATED-APPLICATION-REPORT-1/);
  const second=await f.interact('SECOND-GENERATED-APP-INTERACTION');assert.equal(second.status,'completed',JSON.stringify(second));
  assert.ok(JSON.stringify(f.requests[1]).includes('FIRST-GENERATED-APP-INTERACTION'),'original SDK resume loads its own first input');
  assert.ok(JSON.stringify(f.requests[1]).includes('Generated application answer 1'),'original SDK history retains its own prior response');
  assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-2\n');
  await f.restart();
  const third=await f.interact('THIRD-GENERATED-APP-INTERACTION-AFTER-RESTART');assert.equal(third.status,'completed',JSON.stringify(third));
  assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-3\n');
  const events=(await readFile(f.trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {event:string;pid:number});assert.equal(events.filter(event=>event.event==='factory-create').length,1);assert.equal(events.filter(event=>event.event==='factory-resume').length,2);
  for(const pid of new Set(events.map(event=>event.pid)))assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as {code:string}).code==='ESRCH');
  assert.equal((await f.action('disable')).statusCode,200);
  assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-3\n','an independently accepted product does not borrow native activation as a global read grant');
  const denied=await f.interact('DISABLED-APP-CANNOT-RESTORE');assert.equal(denied.status,'failed',JSON.stringify(denied));assert.equal(f.requests.length,3);
});

const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const outputText=(f:Awaited<ReturnType<typeof applicationFixture>>,sourceId:string,path='report.txt')=>f.node.materials.read(materialId(sourceId,path),{offset:0,length:12000}).text;
const control=(f:Awaited<ReturnType<typeof applicationFixture>>)=>JSON.parse(String(f.controlRows()[0]!.json));
const terminalResponse=(response:ServerResponse,index:number)=>{if(!response.destroyed)writeMessagesResponse(response,{stage:1,model:'generated-native-model',text:JSON.stringify({answer:'Generated application answer '+index,citationIds:[]})});};

for(const stop of ['cancel','disable'] as const)test(`APP ${stop} protects pending input but restart and a fresh interaction cannot publish its unchanged products`,{timeout:30000},async t=>{
  const entered=gate(),release=gate();
  const f=await applicationFixture(t,{hook:"if(count===0){fs.writeFileSync(path.join(process.cwd(),'report.txt'),'GENERATED-CANCELLED-PRODUCT');fs.writeFileSync(path.join(process.cwd(),'status.json'),JSON.stringify({count:1}));}",respond:async(_,response,index)=>{if(index===1){entered.release();await release.promise;}terminalResponse(response,index);}});
  t.after(()=>release.release());
  const message=await f.enqueue('GENERATED-INTERRUPTED-APP-'+stop);await entered.promise;
  if(stop==='cancel')assert.equal((await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.conversationId+'/messages/'+message.id+'/cancel',headers:f.headers})).statusCode,200);
  else assert.equal((await f.action('disable')).statusCode,200);
  release.release();const stopped=await f.settled(message);assert.equal(stopped.status,stop==='cancel'?'cancelled':'failed',JSON.stringify(stopped));
  await waitFor(()=>Boolean(f.controlRows().length)&&!existsSync(join(f.root,'vault','native-applications',control(f).identity,'working')),'protected pending SDK input');
  const pending=control(f);assert.equal(pending.accepted,undefined);assert.ok(pending.pending);
  assert.equal(f.node.sources.listSources().filter(source=>source.id.startsWith('dsh-app:')).length,0);
  const pendingManifest=join(f.root,'vault','native-applications',pending.identity,'generations',pending.pending,'manifest');assert.equal(existsSync(pendingManifest+'.aes'),true);
  await f.restart();assert.equal(f.requests.length,1,'startup alone must not revive a cancelled native task');assert.equal(control(f).accepted,undefined);
  if(stop==='disable'){assert.equal((await f.action('enable')).statusCode,200);await waitFor(async()=>(await f.node.app.inject({url:'/api/agent-runtime/native-modules',headers:f.headers})).json().items.some((item:any)=>item.active&&item.reference.contribution.instance.instanceId===f.instanceId),'fresh native application activation');}
  const next=await f.interact('GENERATED-EXPLICIT-NEW-APP-INTERACTION');assert.equal(next.status,'completed',JSON.stringify(next));assert.equal(f.requests.length,2);
  assert.match(JSON.stringify(f.requests[1]),/GENERATED-EXPLICIT-NEW-APP-INTERACTION/);
  assert.ok(control(f).accepted);assert.equal(control(f).pending,undefined);
  assert.equal(f.node.sources.listSources().filter(source=>source.id.startsWith('dsh-app:')).length,0,'unchanged cancelled workspace files are not new successful products');
});

test('APP control CAS conflicts and actual output write failures roll back all products and the accepted checkpoint',{timeout:30000},async t=>{
  const entered=gate(),release=gate();
  const f=await applicationFixture(t,{respond:async(_,response,index)=>{if(index===1){entered.release();await release.promise;}terminalResponse(response,index);}});t.after(()=>release.release());
  const first=await f.enqueue('GENERATED-CONTROL-CONFLICT');await entered.promise;
  const row=f.controlRows()[0]!;f.node.store.db.prepare('UPDATE plugin_instance_state SET revision=revision+1 WHERE key=?').run(row.key);
  release.release();const failed=await f.settled(first);assert.equal(failed.status,'failed',JSON.stringify(failed));assert.equal(control(f).accepted,undefined);
  assert.equal(Number(f.node.store.db.prepare("SELECT count(*) n FROM source_versions WHERE source_id LIKE 'dsh-app:%'").get()!.n),0);
  assert.equal(f.node.store.db.isTransaction,false);
  await f.restart();
  const restore=rejectSqliteWrites(f.node.store,'material_blocks');
  const publicationFailure=await f.interact('GENERATED-OUTPUT-SQL-FAILURE');assert.equal(publicationFailure.status,'failed',JSON.stringify(publicationFailure));assert.equal(control(f).accepted,undefined);
  assert.equal(Number(f.node.store.db.prepare("SELECT count(*) n FROM source_versions WHERE source_id LIKE 'dsh-app:%'").get()!.n),0);assert.equal(f.node.store.db.isTransaction,false);restore();
  await f.restart();const recovered=await f.interact('GENERATED-OUTPUT-RECOVERED');assert.equal(recovered.status,'completed',JSON.stringify(recovered));assert.ok(control(f).accepted);
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!;assert.equal(f.node.sources.history(source.id,'report.txt').length,1);assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-3\n');
  assert.equal(f.node.archivedFiles.listForCapture(f.node.sources.getItem(source.id,'report.txt')!.captureId).length,0,'metadata references offer no archived-file download bypass');
});

async function parentInput(f:Awaited<ReturnType<typeof applicationFixture>>){
  const sourceId='generated.app-parent',text='GENERATED-PRIVATE-PARENT-CONTENT';
  const registration=await f.node.app.inject({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:sourceId,name:'Generated private application input',kind:'custom',deviceId:'generated-input-device',platform:'import',retention:'archive'}});assert.equal(registration.statusCode,200,registration.body);
  const item=await f.node.app.inject({method:'PUT',url:'/api/sources/'+sourceId+'/items',headers:f.headers,payload:{externalId:'private-parent',revision:'1',observedAt:new Date().toISOString(),title:'Generated input',text,kind:'file',layer:'original'}});assert.equal(item.statusCode,200,item.body);
  return {sourceId,id:item.json().id as string,text};
}

async function memoryFileInput(f:Awaited<ReturnType<typeof applicationFixture>>){
  const sourceId='generated.app-memory-input',text='GENERATED PRIVATE ORIGINAL: the owner prefers quiet mornings.',statement='GENERATED SCOPED MEMORY: quiet mornings suit careful work.';
  const registration=await f.node.app.inject({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:sourceId,name:'Generated Memory file input',kind:'local-files',deviceId:'generated-memory-device',platform:'import',retention:'archive'}});assert.equal(registration.statusCode,200,registration.body);
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),request=(url:string,method:'POST'|'PUT',payload:unknown)=>f.node.app.inject({url,method,headers:{...f.headers,'x-mote-ingress-version':'2',...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})},payload});
  const begun=await request('/api/file-sync/v1/uploads','POST',{sourceId,previousRevision:null,relativePath:'generated.png',sizeBytes:bytes.length,sha256:sha256(bytes),item:{externalId:'generated-original',revision:'1',observedAt:new Date().toISOString(),title:'Generated original image',kind:'file',layer:'original',text:'',mimeType:'image/png'}});assert.equal(begun.statusCode,200,begun.body);
  assert.equal((await request('/api/file-sync/v1/uploads/'+begun.json().uploadId+'/parts/0','PUT',bytes)).statusCode,200);
  const committed=await request('/api/file-sync/v1/uploads/'+begun.json().uploadId+'/commit','POST',{});assert.equal(committed.statusCode,200,committed.body);const fileId=committed.json().id as string,artifactId=randomUUID(),chunkId=randomUUID();
  // Generated processing output, consumed by the real Memory extraction and
  // owner publication path; neither a real OCR model nor a hand-made card DTO.
  f.node.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,fileId,'text',new Date().toISOString(),'generated',JSON.stringify({complete:true}));
  f.node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,text,metadata) VALUES(?,?,?,?,?)').run(chunkId,artifactId,fileId,text,'{}');
  const memories=f.node.evidenceContext.assembly.reader.memories,original=memories.readEvidence([chunkId])[0]!;assert.ok(original);
  const extracted=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated scoped preference',statement,uncertainty:'Generated fixture, revisable by its owner.',evidenceIds:[chunkId]}]}),citations:[{id:chunkId,capturedAt:original.capturedAt,appName:original.appName,excerpt:original.ocrText}],trace:[],runId:randomUUID()}),'generated').items[0]!;
  const published=await f.node.app.inject({method:'POST',url:'/api/memories/'+extracted.id+'/publish',headers:f.headers,payload:{version:extracted.version}});assert.equal(published.statusCode,200,published.body);
  return {sourceId,fileId,chunkId,text,statement,memory:published.json(),async release(){const response=await f.node.app.inject({method:'DELETE',url:'/api/files/'+fileId,headers:f.headers});assert.equal(response.statusCode,200,response.body);const retained=await f.node.app.inject({url:'/api/memories/'+extracted.id,headers:f.headers});assert.equal(retained.statusCode,200,retained.body);assert.equal(retained.json().status,'published');assert.equal(retained.json().evidence[0].originalAvailable,false);}};
}

test('installed APP Memory-only SDK history and independent Materials survive ordinary original release, but forgetting rejects late products and restoration',{timeout:30000},async t=>{
  const entered=gate(),release=gate();let input:Awaited<ReturnType<typeof memoryFileInput>>;
  const f=await applicationFixture(t,{respond:async(request,response,index)=>{
    if(index===1){writeMessagesResponse(response,{stage:0,model:'generated-native-model',tool:{name:'memories',args:{id:input.memory.id}}});return;}
    if(index===2){assert.match(JSON.stringify(request),new RegExp(input.statement));assert.doesNotMatch(JSON.stringify(request),new RegExp(input.text));}
    if(index===4){entered.release();await release.promise;}
    terminalResponse(response,index);
  }});t.after(()=>release.release());input=await memoryFileInput(f);
  const first=await f.interact('GENERATED-APP-MEMORY-ONLY');assert.equal(first.status,'completed',JSON.stringify(first));assert.deepEqual(f.node.conversations.get(f.conversationId).turns.find(turn=>turn.id===first.id)!.result!.originalEvidenceDependencies,{version:1,complete:true,ids:[]});
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!,report=f.node.materials.get(materialId(source.id,'report.txt'))!;
  const groups=f.node.materials.derivation(report.ref)!.groups;assert.ok(groups.some(group=>group.memoryPins.some(pin=>pin.id===input.memory.id)));assert.ok(groups.every(group=>!group.originalEvidenceIds.length));
  await input.release();assert.equal((await f.node.app.inject({url:'/api/files/'+input.fileId+'/content',headers:f.headers})).statusCode,404);
  assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-2\n');assert.deepEqual(f.node.evidenceContext.assembly.reader.evidence(['capture:'+input.chunkId]),[]);
  const readAfterRelease=await f.node.app.inject({url:'/api/materials/'+report.id+'/read',headers:f.headers});assert.equal(readAfterRelease.statusCode,200,readAfterRelease.body);assert.match(readAfterRelease.body,/GENERATED-APPLICATION-REPORT-2/);
  const anchors=f.node.materials.evidenceIds(report.ref);assert.ok(f.node.materials.evidence(anchors).length);await f.node.materials.index!.tick();const searchable=await f.node.app.inject({url:'/api/library/catalog?query=GENERATED-APPLICATION-REPORT',headers:f.headers});assert.equal(searchable.statusCode,200,searchable.body);assert.ok(searchable.json().items.some((item:any)=>item.id===report.id));
  await f.restart();const second=await f.interact('GENERATED-APP-RETAINED-MEMORY-FOLLOWUP');assert.equal(second.status,'completed',JSON.stringify({second,run:f.node.queryRuns.get(second.runId)}));assert.equal(f.requests.length,3);assert.match(JSON.stringify(f.requests[2]),/GENERATED-APP-MEMORY-ONLY/);assert.match(JSON.stringify(f.requests[2]),new RegExp(input.statement));
  assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-3\n');const accepted=control(f).accepted,revision=f.node.materials.get(report.id)!.revision;
  const late=await f.enqueue('GENERATED-APP-MEMORY-FORGOTTEN-WHILE-RUNNING');await entered.promise;
  const forgotten=await f.node.app.inject({method:'DELETE',url:'/api/memories/'+input.memory.id,headers:f.headers});assert.equal(forgotten.statusCode,200,forgotten.body);release.release();assert.equal((await f.settled(late)).status,'failed');assert.equal(control(f).accepted,accepted);assert.equal(f.node.materials.get(report.id)!.revision,revision);
  assert.equal((await f.node.app.inject({url:'/api/materials/'+report.id+'/read',headers:f.headers})).statusCode,409);assert.throws(()=>f.node.materials.block(report.ref,0),{statusCode:409});assert.deepEqual(f.node.materials.evidence(anchors),[]);const found=await f.node.app.inject({url:'/api/library/catalog?query=GENERATED-APPLICATION-REPORT',headers:f.headers});assert.equal(found.statusCode,200,found.body);assert.ok(!found.json().items.some((item:any)=>item.id===report.id));
  await f.restart();let bodies=0;const read=f.node.store.contentEncryption.read.bind(f.node.store.contentEncryption);t.mock.method(f.node.store.contentEncryption,'read',(path:string)=>{if(path.includes('native-applications')&&!path.endsWith('manifest'))bodies++;return read(path);});
  const denied=await f.interact('GENERATED-APP-CANNOT-RESTORE-FORGOTTEN-MEMORY');assert.equal(denied.status,'failed',JSON.stringify(denied));assert.equal(f.requests.length,4);assert.equal(bodies,0);assert.equal(control(f).accepted,accepted);
});

for(const role of ['raw','pixels'] as const)test(`installed APP ${role} disclosure cannot borrow Memory permission after original release or publish late output`,{timeout:30000},async t=>{
  const entered=gate(),release=gate();let input:Awaited<ReturnType<typeof memoryFileInput>>;
  const f=await applicationFixture(t,{respond:async(request,response,index)=>{
    if(index===1){writeMessagesResponse(response,{stage:0,model:'generated-native-model',tool:{name:'memories',args:{id:input.memory.id}}});return;}
    if(index===2){assert.match(JSON.stringify(request),new RegExp(input.statement));writeMessagesResponse(response,{stage:1,model:'generated-native-model',tool:role==='raw'?{name:'evidence',args:{ids:[input.chunkId]}}:{name:'read_image',args:{id:input.fileId}}});return;}
    if(role==='raw')assert.match(JSON.stringify(request),new RegExp(input.text));else assert.ok(request.messages.flatMap((message:any)=>message.content).flatMap((part:any)=>part.type==='tool_result'?part.content:[part]).some((part:any)=>part.type==='image'&&part.source?.type==='base64'&&part.source.data.length>0),'the real SDK sender must receive pixels, not metadata alone');
    entered.release();await release.promise;terminalResponse(response,index);
  }});t.after(()=>release.release());input=await memoryFileInput(f);if(role==='pixels')await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:true}});
  const message=await f.enqueue('GENERATED-APP-MEMORY-AND-'+role,role==='pixels'?{attachmentIds:[input.fileId]}:{});await entered.promise;
  const receipts=f.node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/exposure/%'").all().map(row=>JSON.parse(String(row.json)));assert.ok(receipts.some(receipt=>receipt.originalEvidenceIds.includes(role==='raw'?input.chunkId:input.fileId)));
  await input.release();release.release();const failed=await f.settled(message);assert.equal(failed.status,'failed',JSON.stringify(failed));assert.equal(control(f).accepted,undefined);assert.equal(f.node.sources.listSources().filter(source=>source.id.startsWith('dsh-app:')).length,0);
  await f.restart();const denied=await f.interact('GENERATED-APP-CANNOT-RESTORE-'+role);assert.equal(denied.status,'failed',JSON.stringify(denied));assert.equal(f.requests.length,3);assert.equal(control(f).accepted,undefined);assert.equal(existsSync(join(f.root,'vault','native-applications',control(f).identity,'working')),false);
});

test('real APP Material outputs retain parent lineage and current source withdrawal blocks SDK restoration before decryption',{timeout:30000},async t=>{
  const f=await applicationFixture(t),parent=await parentInput(f);
  const first=await f.interact('GENERATED-APP-READS-PRIVATE-PARENT',{scope:{kind:'selection',evidenceIds:[parent.id]}});assert.equal(first.status,'completed',JSON.stringify(first));assert.match(JSON.stringify(f.requests[0]),new RegExp(parent.text));
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!,item=f.node.sources.getItem(source.id,'report.txt')!;
  assert.equal(f.node.store.db.prepare('SELECT 1 FROM file_evidence_links WHERE capture_id=?').get(item.captureId),undefined,'generic product lineage is not a file attachment');
  await f.node.materialOrganizer.tick(20);const report=f.node.materials.list({sourceId:source.id}).items.find(material=>material.origin.externalId==='report.txt')!;assert.match(f.node.materials.read(report.ref,{offset:0,length:10000})!.text,/GENERATED-APPLICATION-REPORT-1/);
  assert.equal('derivation' in report,false,'private proof groups are not a body/catalog DTO');
  const meta=await f.node.app.inject({url:'/api/sources/'+source.id+'/items',headers:f.headers});assert.equal(meta.statusCode,200,meta.body);assert.doesNotMatch(meta.body,/GENERATED-APPLICATION-REPORT-1/);
  assert.equal(f.node.archivedFiles.listForCapture(item.captureId).length,0);
  const bodyBefore=await f.node.app.inject({url:'/api/materials/'+report.id+'/read',headers:f.headers});assert.equal(bodyBefore.statusCode,200,bodyBefore.body);assert.match(bodyBefore.body,/GENERATED-APPLICATION-REPORT-1/);
  await f.node.materials.index!.tick();const found=await f.node.app.inject({url:'/api/library/catalog?query=GENERATED-APPLICATION-REPORT-1',headers:f.headers});assert.equal(found.statusCode,200,found.body);assert.ok(found.json().items.some((item:any)=>item.id===report.id));
  const anchors=f.node.materials.evidenceIds(report.ref),dependencies=resolveDependencies(f.node.store,{version:1,complete:true,ids:anchors})!;assert.ok(dependencies.ids.includes(parent.id));assert.equal(f.node.evidenceContext.assembly.reader.contextDependenciesAllowed(dependencies.ids),true);
  const consumed=await f.node.app.inject({method:'POST',url:'/api/query',headers:f.headers,payload:{question:'GENERATED-REAL-MATERIAL-CONSUMPTION',evidenceIds:[anchors[0]]}});assert.equal(consumed.statusCode,200,consumed.body);assert.match(JSON.stringify(f.requests[1]),/GENERATED-APPLICATION-REPORT-1/);
  const before=control(f).accepted;
  const withdrawal=await f.node.app.inject({method:'PUT',url:'/api/sources/'+parent.sourceId+'/items',headers:f.headers,payload:{externalId:'private-parent',revision:'2',observedAt:new Date().toISOString(),title:'Generated withdrawn input',text:'',kind:'file',layer:'original',deleted:true}});assert.equal(withdrawal.statusCode,200,withdrawal.body);
  assert.equal((await f.node.app.inject({url:'/api/materials/'+report.id+'/read',headers:f.headers})).statusCode,409);assert.throws(()=>f.node.materials.block(report.ref,0),{statusCode:409});assert.deepEqual(f.node.materials.evidence(anchors),[]);
  const deniedSearch=await f.node.app.inject({url:'/api/library/catalog?query=GENERATED-APPLICATION-REPORT-1',headers:f.headers});assert.equal(deniedSearch.statusCode,200,deniedSearch.body);assert.ok(!deniedSearch.json().items.some((item:any)=>item.id===report.id));
  assert.ok(f.node.materials.list({sourceId:source.id}).items.some(material=>material.id===report.id),'metadata still exposes the independently retained product');
  const deniedRead=await f.node.app.inject({method:'POST',url:'/api/query',headers:f.headers,payload:{question:'GENERATED-WITHDRAWN-MATERIAL-CONSUMPTION',evidenceIds:[anchors[0]]}});assert.equal(deniedRead.statusCode,409,deniedRead.body);assert.equal(f.requests.length,2);
  await f.restart();const denied=await f.interact('GENERATED-APP-CANNOT-RELOAD-WITHDRAWN-SOURCE');assert.equal(denied.status,'failed',JSON.stringify(denied));assert.equal(f.requests.length,2);assert.equal(control(f).accepted,before);
  assert.equal(existsSync(join(f.root,'vault','native-applications',control(f).identity,'working')),false);
});

test('APP retains actual raw tool delivery from a cancelled turn even though Mote successful history omits it',{timeout:30000},async t=>{
  const delivered=gate(),release=gate();let parent:Awaited<ReturnType<typeof parentInput>>|undefined;
  const f=await applicationFixture(t,{respond:async(request,response,index)=>{
    if(index===1){assert.ok(request.tools.some((tool:any)=>tool.name==='search_context'));writeMessagesResponse(response,{stage:0,model:'generated-native-model',tool:{name:'search_context',args:{query:'GENERATED PRIVATE PARENT',limit:5}}});}
    else{assert.match(JSON.stringify(request),new RegExp(parent!.text));delivered.release();await release.promise;terminalResponse(response,index);}
  }});t.after(()=>release.release());parent=await parentInput(f);
  const pending=await f.enqueue('GENERATED-NATIVE-TOOL-DISCLOSURE-THEN-CANCEL');await delivered.promise;
  assert.equal((await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.conversationId+'/messages/'+pending.id+'/cancel',headers:f.headers})).statusCode,200);release.release();assert.equal((await f.settled(pending)).status,'cancelled');
  await waitFor(()=>!existsSync(join(f.root,'vault','native-applications',control(f).identity,'working')),'quiesced cancelled tool history');
  const receipts=f.node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/exposure/%'").all().map(row=>JSON.parse(String(row.json)));
  assert.ok(receipts.some(receipt=>receipt.originalEvidenceIds.includes(parent!.id)),'potential native persistence has a strict raw-body receipt independent of final answer success');assert.equal(control(f).accepted,undefined);
  const withdrawal=await f.node.app.inject({method:'PUT',url:'/api/sources/'+parent.sourceId+'/items',headers:f.headers,payload:{externalId:'private-parent',revision:'2',observedAt:new Date().toISOString(),title:'Generated withdrawn input',text:'',kind:'file',layer:'original',deleted:true}});assert.equal(withdrawal.statusCode,200,withdrawal.body);
  await f.restart();const refused=await f.interact('GENERATED-FRESH-QUESTION-CANNOT-LOAD-OLD-RAW');assert.equal(refused.status,'failed',JSON.stringify(refused));assert.equal(f.requests.length,2,'failed/cancelled native history cannot bypass revocation by falling outside Mote successful turns');
  assert.equal(existsSync(join(f.root,'vault','native-applications',control(f).identity,'working')),false);assert.equal(control(f).accepted,undefined);
});

test('two installed APP instances, profiles and conversations keep separate SDK sessions and workspace state',{timeout:30000},async t=>{
  const f=await applicationFixture(t),packageId=f.packageId;
  const sibling=await f.node.app.inject({method:'POST',url:'/api/plugin-instances',headers:f.headers,payload:{packageId,name:'Generated second native application',scope:'default',configuration:{},expectedRevision:f.node.pluginCenter.revision(),operationId:randomUUID()}});assert.equal(sibling.statusCode,200,sibling.body);const instanceId=sibling.json().id as string;
  for(const action of ['check','enable']){const response=await f.node.app.inject({method:'POST',url:'/api/plugin-instances/'+instanceId+'/'+action,headers:f.headers,payload:{expectedRevision:f.node.pluginCenter.instanceView(instanceId).revision,operationId:randomUUID()}});assert.equal(response.statusCode,200,response.body);await waitFor(()=>f.node.pluginCenter.instanceView(instanceId).observed==='ready',action);}
  const modules=(await f.node.app.inject({url:'/api/agent-runtime/native-modules',headers:f.headers})).json().items.filter((module:any)=>module.reference.contribution.instance.instanceId===instanceId),byId=(id:string)=>modules.find((module:any)=>module.reference.contribution.contributionId===id).reference;
  const modelProfileId='native-app-other',settings=f.node.modelSettings.select('chat',f.modelProfileId).settings;
  const modelSettings=await f.node.app.inject({method:'PUT',url:'/api/configuration/models',headers:f.headers,payload:{revision:f.node.configService.revision,value:{profiles:[{id:f.modelProfileId,name:'Generated first app model',settings},{id:modelProfileId,name:'Generated second app model',settings}]}}});assert.equal(modelSettings.statusCode,200,modelSettings.body);
  const profile={...f.profile,modelProfileId,assembly:{packages:[byId('generated.native-package')],hooks:[byId('generated.native-hook')],factory:byId('generated.native-factory')},grants:[{instance:modules[0].reference.contribution.instance,capabilities:modules[0].requestedCapabilities}],application:{...f.profile.application,instance:modules[0].reference.contribution.instance}};
  assert.equal((await f.node.app.inject({method:'PUT',url:'/api/configuration/dsh',headers:f.headers,payload:{revision:f.node.configService.revision,value:{profiles:[f.profile,profile]}}})).statusCode,200);
  assert.equal((await f.node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers:f.headers,payload:{revision:f.node.configService.revision,value:{multipleConversations:true}}})).statusCode,200);await f.restart();
  assert.equal((await f.interact('GENERATED-INSTANCE-A-CONVERSATION-A')).status,'completed');assert.equal((await f.interact('GENERATED-INSTANCE-B-CONVERSATION-A',{modelProfileId})).status,'completed');
  const conversation=await f.node.app.inject({method:'POST',url:'/api/conversations',headers:f.headers,payload:{}});assert.equal(conversation.statusCode,201,conversation.body);
  assert.equal((await f.interact('GENERATED-INSTANCE-A-CONVERSATION-B',{conversationId:conversation.json().id})).status,'completed');assert.doesNotMatch(JSON.stringify(f.requests[2]),/GENERATED-INSTANCE-[AB]-CONVERSATION-A/);
  assert.equal((await f.interact('GENERATED-INSTANCE-A-CONVERSATION-A-RESUME')).status,'completed');assert.equal(f.controlRows().length,3);
  const reports=f.node.sources.listSources().filter(source=>source.id.startsWith('dsh-app:')).map(source=>outputText(f,source.id).trim()).sort();assert.deepEqual(reports,['GENERATED-APPLICATION-REPORT-1','GENERATED-APPLICATION-REPORT-1','GENERATED-APPLICATION-REPORT-2']);
  const events=(await readFile(f.trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(events.filter(event=>event.event==='factory-create').length,3);assert.equal(events.filter(event=>event.event==='factory-resume').length,1);
});

test('the actual APP publisher rejects a declared workspace symlink without accepting a checkpoint or publishing its target',{timeout:30000},async t=>{
  const f=await applicationFixture(t,{hook:root=>`fs.symlinkSync(${JSON.stringify(join(root,'outside.txt'))},path.join(process.cwd(),'report.txt'));`});await writeFile(join(f.root,'outside.txt'),'GENERATED-OUTSIDE-WORKSPACE');
  const failed=await f.interact('GENERATED-UNSAFE-WORKSPACE-OUTPUT');assert.equal(failed.status,'failed',JSON.stringify(failed));assert.equal(control(f).accepted,undefined);assert.equal(f.node.sources.listSources().filter(source=>source.id.startsWith('dsh-app:')).length,0);assert.equal(await readFile(join(f.root,'outside.txt'),'utf8'),'GENERATED-OUTSIDE-WORKSPACE');
  const pending=control(f),privateRoot=join(f.root,'vault','native-applications',pending.identity);assert.equal(existsSync(join(privateRoot,'working')),false,'unsafe workspace nodes do not leave an idle plaintext SDK history');assert.equal(existsSync(join(privateRoot,'generations',pending.pending,'manifest.aes')),true);
});

test('workspace output reads reject a parent path replaced after the pinned descriptor was read',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-native-file-race-')),workspace=join(root,'workspace'),output=join(workspace,'output'),outside=join(root,'outside');mkdirSync(output,{recursive:true});mkdirSync(outside);await writeFile(join(output,'report.txt'),'GENERATED-EXPECTED-OUTPUT');await writeFile(join(outside,'report.txt'),'GENERATED-OUTSIDE-OUTPUT');
  const original=fs.readFileSync;
  t.after(()=>{fs.readFileSync=original;syncBuiltinESMExports();return rm(root,{recursive:true,force:true});});
  fs.readFileSync=((...args:any[])=>{const bytes=(original as any)(...args);if(typeof args[0]==='number'){renameSync(output,join(workspace,'replaced'));symlinkSync(outside,output);}return bytes;}) as typeof fs.readFileSync;syncBuiltinESMExports();
  assert.throws(()=>readNativeFile(workspace,'output/report.txt'));assert.equal(original(join(outside,'report.txt'),'utf8'),'GENERATED-OUTSIDE-OUTPUT');
});

test('APP outputs derived from a real FileStore input stay independent source items and never alias the input original', {timeout:30000},async t=>{
  const f=await applicationFixture(t),sourceId='generated.app-file-input',bytes=Buffer.from('GENERATED-PRIVATE-FILE-INPUT');
  const registration=await f.node.app.inject({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:sourceId,name:'Generated original file input',kind:'local-files',deviceId:'generated-file-input-device',platform:'import',retention:'archive'}});assert.equal(registration.statusCode,200,registration.body);
  const manifest={sourceId,previousRevision:null,relativePath:'input.txt',sizeBytes:bytes.length,sha256:sha256(bytes),item:{externalId:'generated-original-file',revision:'1',observedAt:new Date().toISOString(),title:'Generated original file',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false}};
  const begun=f.node.files.begin(manifest,()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});const input=await f.node.files.commit(begun.uploadId,()=>{});
  const answer=await f.interact('GENERATED-READ-REAL-FILE-INPUT',{scope:{kind:'selection',evidenceIds:[input.id]}});assert.equal(answer.status,'completed',JSON.stringify(answer));
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!,output=f.node.sources.getItem(source.id,'report.txt')!;
  assert.equal(f.node.sources.listItems({sourceId:source.id}).items.length,2,'an APP product is not a hidden extraction attachment of its input');
  assert.equal(f.node.files.fileForRead(output.captureId),undefined,'a generated product cannot resolve to the parent file original');
});

test('APP output selection rejects undeclared roles and nontext paths, and preserves UTF-8 bytes including BOM', {timeout:30000},async t=>{
  const text='\uFEFFGENERATED UTF-8 中🙂\r\n';
  const f=await applicationFixture(t,{hook:`fs.writeFileSync(path.join(process.cwd(),'report.txt'),${JSON.stringify(text)});`});
  const revision=f.node.configService.revision;
  for(const application of [
    {...f.profile.application,outputs:[{path:'../outside.txt',mimeType:'text/plain'}]},
    {...f.profile.application,outputs:[{path:'output.bin',mimeType:'application/octet-stream'}]},
    {...f.profile.application,session:'arbitrary-native-id'},
    {...f.profile.application,instance:{...f.profile.application.instance,instanceId:'not-selected'}},
  ]){const response=await f.node.app.inject({method:'PUT',url:'/api/configuration/dsh',headers:f.headers,payload:{revision,value:{profiles:[{...f.profile,application}]}}});assert.equal(response.statusCode,400,response.body);assert.equal(f.node.configService.revision,revision);}
  const deniedGrant=await f.node.app.inject({method:'PUT',url:'/api/configuration/dsh',headers:f.headers,payload:{revision,value:{profiles:[{...f.profile,grants:f.profile.grants.map(grant=>({...grant,capabilities:grant.capabilities.filter(capability=>capability!=='mote.application.outputs')}))}]}}});assert.equal(deniedGrant.statusCode,400,deniedGrant.body);
  const result=await f.interact('GENERATED-UTF8-TEXT-OUTPUT');assert.equal(result.status,'completed',JSON.stringify(result));
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!,id=materialId(source.id,'report.txt'),material=f.node.materials.get(id)!;
  assert.deepEqual(Buffer.from(f.node.materials.block(material.ref,0)!.block.text,'utf8'),Buffer.from(text,'utf8'));
  const derivation=f.node.materials.derivation(material.ref)!;
  assert.throws(()=>f.node.materials.publish({...material,derivation} as any));
  assert.throws(()=>f.node.materials.publish({id,kind:'mote.native-application-output',schemaVersion:1,title:'Forged output',origin:material.origin,members:[],blocks:[],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}}),{statusCode:403});
  const before=material.revision;await f.node.materialOrganizer.tick(20);assert.equal(f.node.materials.get(id)!.revision,before,'the ordinary metadata organizer cannot replace an accepted Host body');
});

test('invalid UTF-8 output fails visibly while retaining encrypted pending bytes and accepting no product', {timeout:30000},async t=>{
  const f=await applicationFixture(t,{hook:"fs.writeFileSync(path.join(process.cwd(),'report.txt'),Buffer.from([0xff,0xfe,0x61]));"});
  const result=await f.interact('GENERATED-INVALID-UTF8-OUTPUT');assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(control(f).accepted,undefined);assert.equal(Number(f.node.store.db.prepare("SELECT count(*) n FROM source_versions WHERE source_id LIKE 'dsh-app:%'").get()!.n),0);
  const state=control(f),snapshot=join(f.root,'vault','native-applications',state.identity,'generations',state.pending,'manifest');assert.equal(existsSync(snapshot+'.aes'),true);assert.equal(existsSync(snapshot+'.plain'),false);
});

test('a missing cancelled-or-successful disclosure receipt rejects SDK restoration without revoking an independently accepted Material', {timeout:30000},async t=>{
  const f=await applicationFixture(t),parent=await parentInput(f),first=await f.interact('GENERATED-LEDGER-COMPLETENESS',{scope:{kind:'selection',evidenceIds:[parent.id]}});assert.equal(first.status,'completed',JSON.stringify(first));
  const source=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!,accepted=control(f).accepted;
  const receipt=f.node.store.db.prepare("SELECT key,json FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/exposure/%'").all().find(row=>JSON.parse(String(row.json)).originalEvidenceIds.includes(parent.id));assert.ok(receipt);
  f.node.store.db.prepare('DELETE FROM plugin_instance_state WHERE key=?').run(receipt!.key);await f.restart();
  let bodies=0;const original=f.node.store.contentEncryption.read.bind(f.node.store.contentEncryption);
  t.mock.method(f.node.store.contentEncryption,'read',(path:string)=>{if(path.includes('native-applications')&&!path.endsWith('manifest'))bodies++;return original(path);});
  const denied=await f.interact('GENERATED-CANNOT-ASSUME-MISSING-RECEIPT-IS-EMPTY');assert.equal(denied.status,'failed',JSON.stringify(denied));assert.equal(f.requests.length,1);assert.equal(bodies,0,'the protected manifest verifies its required receipt hashes before decrypting any SDK/history file');assert.equal(control(f).accepted,accepted);
  assert.equal(outputText(f,source.id),'GENERATED-APPLICATION-REPORT-1\n');
});

test('APP restores under the same or broader Host scope but rejects narrower originals, time, device and empty selections', {timeout:30000},async t=>{
  const f=await applicationFixture(t),parent=await parentInput(f),wide={kind:'selection',evidenceIds:[parent.id],deviceId:'generated-input-device',after:'2020-01-01T00:00:00Z',before:'2040-01-01T00:00:00Z'};
  const first=await f.interact('GENERATED-ORIGINAL-SCOPED-APP-INPUT',{scope:wide});assert.equal(first.status,'completed',JSON.stringify(first));
  const same=await f.interact('GENERATED-SAME-SCOPE-CONTINUES',{scope:wide});assert.equal(same.status,'completed',JSON.stringify(same));assert.equal(f.requests.length,2);const accepted=control(f).accepted;
  const other=await f.node.app.inject({method:'PUT',url:'/api/sources/'+parent.sourceId+'/items',headers:f.headers,payload:{externalId:'private-parent-other',revision:'1',observedAt:new Date().toISOString(),title:'Generated other input',text:'GENERATED OTHER PRIVATE INPUT',kind:'file',layer:'original'}});assert.equal(other.statusCode,200,other.body);
  for(const scope of [
    {...wide,evidenceIds:[other.json().id]},
    {...wide,after:'2026-01-01T00:00:00Z',before:'2030-01-01T00:00:00Z'},
    {kind:'all',deviceId:'generated-other-device'},
    {kind:'selection',evidenceIds:[]},
    {kind:'selection',sourceIds:[]},
  ]){
    const denied=await f.interact('GENERATED-NARROWER-SCOPE-CANNOT-LOAD-OLD-APP',{scope});assert.equal(denied.status,'failed',JSON.stringify({scope,denied}));assert.equal(f.requests.length,2);assert.equal(control(f).accepted,accepted);
    assert.equal(existsSync(join(f.root,'vault','native-applications',control(f).identity,'working')),false);
  }
  for(const scope of [{},{kind:'selection'}]){const rejected=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:{conversationId:f.conversationId,clientRequestId:randomUUID(),question:'GENERATED-MISSING-SCOPE-IS-NOT-ALL',modelProfileId:f.modelProfileId,scope}});assert.equal(rejected.statusCode,400,rejected.body);assert.equal(f.requests.length,2);assert.equal(control(f).accepted,accepted);}
  const broader=await f.interact('GENERATED-BROADER-SCOPE-RETAINS-AUTHORIZED-APP',{scope:{kind:'all'}});assert.equal(broader.status,'completed',JSON.stringify(broader));assert.equal(f.requests.length,3);assert.match(JSON.stringify(f.requests[2]),/GENERATED-ORIGINAL-SCOPED-APP-INPUT/);
});

test('the maintenance physical snapshot includes real native application bytes independently of logical content accounting',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-app-physical-')),store=new Store(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  store.measurePhysicalStorage();store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before=store.measurePhysicalStorage();store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const directory=join(root,'native-applications','generated-private-session');mkdirSync(directory,{recursive:true,mode:0o700});const bytes=Buffer.alloc(9973,31);await writeFile(join(directory,'generated-protected-state.aes'),bytes,{mode:0o600});
  const logical=store.logicalBytes(),after=store.measurePhysicalStorage();assert.equal(after.bytes-before.bytes,bytes.length);assert.equal(store.logicalBytes(),logical);assert.ok(after.asOf);
});
