import type {TestContext} from 'node:test';
import {initialize,profilePaths,loadProfile,nativeIdentity,stopNative} from '../../../../scripts/profile-lib.mjs';
import {freePort} from '../../../../scripts/profile-fixtures.mjs';
import {readConfigDocument,serializeConfigDocument} from '@mote/shared/config-file';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8,zipSync} from 'fflate';
import type {RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {buildApp} from '../../src/app.js';
import {configurationFromFile} from '../../src/config.js';
import type {PluginManifest,PluginReleaseTransport} from '../../src/plugin-release.js';
import {sha256} from '../../src/store.js';
import {writeMessagesResponse} from '../../../../scripts/fixtures/messages-provider.js';

export async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
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

export async function applicationFixture(t:TestContext,options:{hook?:string|((root:string)=>string);respond?:(request:any,response:ServerResponse,index:number)=>Promise<void>|void}={}) {
  const root=await mkdtemp(join(tmpdir(),'mote-backup-application-')),paths=profilePaths('test',join(root,'profiles'));await initialize(paths,{runtime:'native',port:String(await freePort())});const path=paths.configFile,trace=join(root,'native-trace.jsonl');
  const release=generatedRelease(trace,typeof options.hook==='function'?options.hook(root):options.hook),owner='generated-app-owner-'+randomUUID(),headers={authorization:'Bearer '+owner},requests:unknown[]=[];
  const model=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body);requests.push(request);if(options.respond)await options.respond(request,res,requests.length);else writeMessagesResponse(res,{stage:1,model:'generated-native-model',text:JSON.stringify({answer:'Generated application answer '+requests.length,citationIds:[]})});});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const initial=readConfigDocument(path).savedDocument;initial.server.token=owner;initial.storage.contentEncryptionEnabled=true;initial.storage.dataKey='57'.repeat(32);initial.diagnostics.level='silent';initial.execution.insightIntervalHours=0;initial.models={deployment:{provider:'deepseek',protocol:'deepseek',baseUrl:'http://127.0.0.1:'+(model.address() as {port:number}).port,model:'generated-native-model',apiKey:'generated-unused',maxTokens:1024,modelRequestTimeoutMs:10000,agentTimeoutMs:20000}};await writeFile(path,serializeConfigDocument(initial));
  let node:Awaited<ReturnType<typeof buildApp>>|undefined;let origin='';
  const api=async(input:any)=>{const response=await fetch(origin+input.url,{method:input.method??'GET',headers:{...input.headers,...(input.payload===undefined?{}:{'content-type':'application/json'})},...(input.payload===undefined?{}:{body:JSON.stringify(input.payload)})}),body=await response.text();return {statusCode:response.status,body,json:()=>JSON.parse(body)};};
  const open=async()=>{node=await buildApp(configurationFromFile(path),{backgroundWorker:false});Object.defineProperty(node.pluginCenter.releases,'transport',{value:release.transport});origin=await node.app.listen({host:'127.0.0.1',port:initial.server.port});return node;};
  const restart=async()=>{await node?.app.close();return open();};const cleanups:Array<()=>Promise<void>|void>=[];
  t.after(async()=>{for(const close of [...cleanups].reverse())await close();await node?.app.close();const p=await loadProfile(paths);const managed=await nativeIdentity(p);if(managed.running&&managed.managed)await stopNative(p);model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  await open();
  const resolved=await api({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:release.repository,tag:release.tag}});assert.equal(resolved.statusCode,200,resolved.body);
  const installed=await api({method:'POST',url:'/api/plugins/install',headers,payload:{previewId:resolved.json().id,expectedRevision:node!.pluginCenter.revision(),operationId:randomUUID()}});assert.equal(installed.statusCode,200,installed.body);
  await waitFor(()=>node!.pluginCenter.view().packages.some(pkg=>pkg.state==='installed'),'install');
  const packageId=node!.pluginCenter.view().packages.find(pkg=>pkg.state==='installed')!.id;
  const configured=await api({method:'POST',url:'/api/plugin-instances',headers,payload:{packageId,name:'Generated native application',scope:'default',configuration:{},expectedRevision:node!.pluginCenter.revision(),operationId:randomUUID()}});assert.equal(configured.statusCode,200,configured.body);
  const instanceId=configured.json().id as string;
  const action=(name:'check'|'enable'|'disable')=>api({method:'POST',url:'/api/plugin-instances/'+instanceId+'/'+name,headers,payload:{expectedRevision:node!.pluginCenter.instanceView(instanceId).revision,operationId:randomUUID()}});
  assert.equal((await action('check')).statusCode,200);await waitFor(()=>node!.pluginCenter.instanceView(instanceId).observed==='ready','check');assert.equal((await action('enable')).statusCode,200);
  const directory=(await api({url:'/api/agent-runtime/native-modules',headers})).json().items as {reference:RuntimeModuleReference;requestedCapabilities:string[]}[];
  const modules=directory.filter(module=>module.reference.contribution.instance.instanceId===instanceId),byId=(id:string)=>modules.find(module=>module.reference.contribution.contributionId===id)!.reference,modelProfileId='native-app';
  assert.equal((await api({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:node!.configService.revision,value:{profiles:[{id:modelProfileId,name:'Generated application model',settings:node!.modelSettings.select('chat').settings}]}}})).statusCode,200);
  const profile={modelProfileId,assembly:{packages:[byId('generated.native-package')],hooks:[byId('generated.native-hook')],factory:byId('generated.native-factory')},grants:[{instance:modules[0]!.reference.contribution.instance,capabilities:modules[0]!.requestedCapabilities}],application:{instance:modules[0]!.reference.contribution.instance,session:'conversation',outputs:[{path:'status.json',mimeType:'application/json'},{path:'report.txt',mimeType:'text/plain'}]}};
  const save=await api({method:'PUT',url:'/api/configuration/dsh',headers,payload:{revision:node!.configService.revision,value:{profiles:[profile]}}});assert.equal(save.statusCode,200,save.body);await restart();
  const conversationId=(await api({url:'/api/conversations/main',headers})).json().id as string;
  const enqueue=async(question:string,extra:Record<string,unknown>={})=>{
    const response=await api({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId,clientRequestId:randomUUID(),question,modelProfileId,scope:{kind:'all'},...extra}});assert.equal(response.statusCode,202,response.body);return response.json();
  };
  const settled=async(message:{id:string;conversationId:string})=>{
    let current:any;await waitFor(async()=>{current=(await api({url:'/api/conversations/'+message.conversationId+'/messages/'+message.id,headers})).json();return ['completed','failed','cancelled'].includes(current.status);},'native application message');return current;
  };
  const interact=async(question:string,extra:Record<string,unknown>={})=>settled(await enqueue(question,extra));
  const controlRows=()=>node!.store.db.prepare("SELECT key,json,revision FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/control'").all();
  return {root,path,paths,api,addCleanup:(fn:()=>Promise<void>|void)=>cleanups.push(fn),trace,headers,requests,modelProfileId,profile,packageId,instanceId,conversationId,action,restart,enqueue,settled,interact,controlRows,get node(){return node!;}};
}
