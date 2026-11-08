import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {PluginReleaseTransport} from '../src/plugin-release.js';

// Self-contained generated worker payload. The embedding request is the only
// external operation; it proves the host abort reaches real worker code.
const generatedWorker = String.raw`
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function createMemoryProvider(configuration){
 let state;try{state=JSON.parse(await readFile(configuration.dataFile,'utf8'));}catch{state={records:[],receipts:{}};}
 const save=async()=>{await mkdir(dirname(configuration.dataFile),{recursive:true});await writeFile(configuration.dataFile,JSON.stringify(state));};
 const matches=(record,input)=>same(record.namespace,input.namespace)&&same(record.key,input.key);
 const receipt=(input,status)=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:hash({namespace:input.namespace,key:input.key,memory:input.memory}),state:status,eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z',...(status==='removed'?{currentRemoved:true,historyRetained:true}:{})});
 return {
  async health(){return {providerId:'generated.embedding-worker',version:'1.0.0',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false},problems:[]};},
  async put(input,signal){
   try{const response=await fetch(configuration.embeddingUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:[input.memory.statement]}),signal});await response.json();}
   catch(error){
    if(signal?.aborted){await mkdir(dirname(configuration.abortFile),{recursive:true});await writeFile(configuration.abortFile,'aborted');}
    throw error;
   }
   const fingerprint=hash(input),prior=state.receipts[input.opId];
   if(prior){if(prior.fingerprint!==fingerprint)throw Error('Generated intent conflict');return prior.value;}
   const existing=state.records.find(record=>matches(record,input));if(existing&&!same(existing.memory,input.memory))throw Error('Generated immutable conflict');
   if(!existing)state.records.push({namespace:input.namespace,key:input.key,memory:input.memory});
   const value=receipt(input,'applied');state.receipts[input.opId]={fingerprint,value};await save();return value;
  },
  async read(input){return state.records.find(record=>matches(record,input))?.memory??null;},
  async remove(input){const prior=state.receipts[input.opId];if(prior)return prior.value;state.records=state.records.filter(record=>!matches(record,input));const value=receipt(input,'removed');state.receipts[input.opId]={fingerprint:hash(input),value};await save();return value;},
  async search(input){const records=state.records.filter(record=>same(record.namespace,input.namespace));return records.filter(record=>!input.keys||input.keys.some(key=>same(key,record.key))).slice(0,input.limit??records.length);},
  async export(input){return state.records.filter(record=>same(record.namespace,input.namespace));},
  async close(){await save();}
 };
}
`;

test('actual app.close reaches bounded worker shutdown while a public migration is blocked on its embedding request',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-native-shutdown-')),owner='generated-native-shutdown-token',commit='a'.repeat(40),repository='generated-fixture/embedding-worker',tag='v1.0.0';let hang=false,entered!:()=>void,aborted=0;const embeddingEntered=new Promise<void>(resolve=>{entered=resolve;});
 const endpoint=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;if(hang){entered();req.once('aborted',()=>aborted++);res.once('close',()=>{if(!res.writableEnded)aborted++;});return;}const body=JSON.parse(raw),input=Array.isArray(body.input)?body.input:[body.input];res.setHeader('content-type','application/json');res.end(JSON.stringify({data:input.map((_:unknown,index:number)=>({object:'embedding',index,embedding:[1,0,0]})),model:'generated-transport'}));});
 await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token:owner,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxStorageBytes:100000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},nodes:Awaited<ReturnType<typeof buildApp>>[]=[];
 const start=async()=>{const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model belongs in this transport/lifecycle fixture');},async close(){}}});nodes.push(node);await node.app.ready();return node;};
 t.after(async()=>{hang=false;endpoint.closeAllConnections();for(const node of nodes)await node.app.close().catch(()=>{});await new Promise<void>(resolve=>endpoint.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
 const node=await start();const archive=zipSync({'worker.mjs':strToU8(generatedWorker)}),manifest={schemaVersion:1,id:'generated.embedding-worker',name:'Generated embedding worker',version:'1.0.0',runtime:'worker',entry:'worker.mjs',archive:{asset:'worker.zip',sha256:createHash('sha256').update(archive).digest('hex')},capabilities:['engine'],configuration:[{id:'dataFile',label:'Generated data file',type:'text',required:true},{id:'embeddingUrl',label:'Generated embedding endpoint',type:'text',required:true},{id:'abortFile',label:'Generated abort marker',type:'text',required:true}],dependencies:[],access:['Generated fixture directory only']};
 const base=`https://github.com/${repository}/releases/download/${tag}/`,transport:PluginReleaseTransport=async url=>{
  if(url.endsWith('/releases/tags/'+tag))return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'worker.zip',browser_download_url:base+'worker.zip'}]}))};
  if(url.endsWith('/commits/'+tag))return {bytes:strToU8(JSON.stringify({sha:commit}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
  if(url===base+'worker.zip')return {bytes:archive};
  throw Error('Unexpected generated release request');
 };
 // Replace only external GitHub transport. Owner HTTP control, installer,
 // capability checks, executor, worker process and SQLite remain product code.
 Object.defineProperty(node.pluginCenter.releases,'transport',{value:transport});
 const request=async(url:string,payload:unknown)=>{const response=await node.app.inject({method:'POST',url,headers:{authorization:'Bearer '+owner},payload});assert.equal(response.statusCode,200,response.body);return response.json();};
 // The generated worker advertises the engine seam; this fixture injects that
 // verified declaration because the host worker ABI exposes repository/retrieval.
 node.pluginCenter.probe=async()=>({capabilities:[{id:'engine',state:'verified'}],issues:[]});
 const preview=await request('/api/plugins/resolve',{repository,tag}),installId=randomUUID();await request('/api/plugins/install',{previewId:preview.id,expectedRevision:node.pluginCenter.revision(),operationId:installId});await node.executor.drain(['plugin-install:'+installId]);const pkg=node.pluginCenter.view().packages[0]!;assert.equal(pkg.state,'installed');
 const instance=await request('/api/plugin-instances',{packageId:pkg.id,name:'Generated embedding shutdown',scope:'default',configuration:{dataFile:join(directory,'generated-worker','provider.json'),embeddingUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1/embeddings`,abortFile:join(directory,'generated-worker','aborted')},operationId:randomUUID(),expectedRevision:node.pluginCenter.revision()}),checkId=randomUUID();
 await request('/api/plugin-instances/'+instance.id+'/check',{operationId:checkId,expectedRevision:node.pluginCenter.instanceView(instance.id).revision});await node.executor.drain(['plugin-check:'+checkId]);assert.equal(node.pluginCenter.instanceView(instance.id).observed,'ready');await request('/api/plugin-instances/'+instance.id+'/enable',{operationId:randomUUID(),expectedRevision:node.pluginCenter.instanceView(instance.id).revision});
 const id=randomUUID(),at='2026-10-12T00:00:00Z',text='Generated native shutdown original telescope.';await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});const memory=node.memories.extract({runId:randomUUID(),answer:JSON.stringify({memories:[{title:'Generated shutdown telescope',statement:text+` [${id}]`,uncertainty:'Generated only',evidenceIds:[id],evidence:[{id,quote:text}],admission:{layer:'memory',reason:'Explicit generated fixture',scope:'Generated telescope only',attribution:'user'}}]}),citations:[{id,capturedAt:at,appName:'Generated',excerpt:text}],trace:[]},'generated-no-model').items[0]!;
 hang=true;const prepareId=randomUUID();await request('/api/memory-spaces/default/binding/prepare',{targetPlanId:'instance:'+instance.id,scope:'default',feeAcknowledged:true,operationId:prepareId,expectedRevision:node.memoryBindings.view().revision});await embeddingEntered;
 assert.equal(node.executor.get('memory-prepare:'+prepareId).state,'running');const started=performance.now();await Promise.race([node.app.close(),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Actual Central shutdown deadlocked behind a worker embedding request')),12000);timer.unref();})]);assert.ok(performance.now()-started<12000);assert.throws(()=>node.memoryAdapters.provider(instance.id),{statusCode:503},'closed adapter cannot create another process while HTTP/executor drains');
 const deadline=Date.now()+5000;while(aborted===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));await access(join(directory,'generated-worker','aborted'));assert.ok(aborted>0,'the hanging embedding request actually observed its socket abort');
 hang=false;endpoint.closeAllConnections();const restarted=await start();assert.equal(restarted.memoryBindings.binding().planId,'mote.builtin','a killed migration never switches authority');assert.deepEqual(restarted.memories.get(memory.id),JSON.parse(JSON.stringify(memory)),'existing host body is preserved');const namespace={ownerId:'mote-owner',instanceId:instance.id,bindingRevision:1},health=await restarted.memoryAdapters.provider(instance.id).recover({namespace});assert.equal(health.ready,true,'a fresh worker opens retained provider state after killed-process recovery');
});
