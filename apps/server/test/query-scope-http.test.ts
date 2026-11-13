import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {memorySchema} from '../src/memory-schema.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';

function seedMemory(node:Awaited<ReturnType<typeof buildApp>>,title:string,ids:string[]){
 const records=node.store.evidence(ids),id=randomUUID(),createdAt='2026-10-02T00:00:00Z';assert.equal(records.length,ids.length);
 const value=memorySchema.parse({version:1,id,domain:'personal',tier:'episode',kind:'episodic',title,statement:title+' generated statement',uncertainty:'Generated fixture',status:'published',createdAt,evidenceIds:ids,model:'generated',runId:randomUUID(),skillVersion:'generated@1',admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture',attribution:'observed'},fingerprint:memoryEvidenceFingerprint(records[0]),evidence:records.map(record=>({id:record.id,deviceId:record.deviceId,sourceId:record.provenance?.sourceId,externalId:record.provenance?.externalId,revision:record.provenance?.revision,capturedAt:record.capturedAt,receivedAt:record.receivedAt,offset:0,length:record.ocrText.length,quote:record.ocrText,contentHash:memoryEvidenceFingerprint(record)})),scopeRefs:[]});
 node.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id,createdAt,JSON.stringify(value));
 for(const evidenceId of ids)node.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id,evidenceId);
}

for(const restriction of ['device','time','withdrawal','source','source-device','source-time','source-withdrawal'] as const)test(`actual query tools restrict source metadata and originals by ${restriction}`,async t=>{
 const sourceScoped=restriction.startsWith('source');
 const directory=mkdtempSync(join(tmpdir(),'mote-query-scope-')),token='generated-query-scope-owner',headers={authorization:'Bearer '+token};
 let node!:Awaited<ReturnType<typeof buildApp>>,fixtureFailure:unknown;
 const cfg:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 node=await buildApp(cfg,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  if(sourceScoped){assert.equal(input.evidenceIds,undefined);assert.equal(input.processingEvidence,undefined);assert.doesNotMatch(JSON.stringify(input),/GENERATED_HIDDEN|GENERATED_VISIBLE_BODY/);}
  const bridge=await startBridge(node.featureServices.archiveReader,input);
  try{
   const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));return value;};
   const capability=async(name:string,args:unknown={})=>{const found=await call('capability_discover',{name});return call('capability_execute',{name,version:found.data.version,argumentsJson:JSON.stringify(args)});};
   const directoryPage=await capability('context_index',{path:'/context/sources'}),sources=await capability('sources');
   const items=await capability('source_items'),search=await call('search_context',{query:'Generated scoped'}),catalog=await call('material_catalog',{}),memories=await call('memories',{});
   if(sourceScoped){
    const segments=await capability('segments'),episodes=await capability('context_index',{path:'/context/episodes'}),activity=await capability('activity'),devices=await capability('devices');
    assert.equal(segments.data.items.length,1,JSON.stringify(segments));
    assert.equal(segments.data.coverage.pendingGroups,undefined);assert.equal(segments.data.coverage.blockedGroups,undefined);
    assert.equal(activity.data.captures,0);assert.equal(activity.data.activityEvents,0);assert.equal(activity.data.totalDurationMs,0,'device activity outside the selected file sources contributes no counts');
    assert.deepEqual(devices.data,[],'a source grant cannot expose unscoped device health or names');
    assert.doesNotMatch(JSON.stringify({segments,episodes,activity,devices}),/GENERATED_HIDDEN|generated-hidden-path/);
   }
   assert.equal(catalog.data.items.length,1,JSON.stringify(catalog));
   const material=await call('material_read',{ref:catalog.data.items[0].ref,length:12000});
   const record=items.data[0];assert.ok(record?.id,JSON.stringify(items));const evidence=await call('evidence',{ids:[record.id]});
   const all={directoryPage,sources,items,search,catalog,material,evidence,memories,openingMemories:input.openingMemories},json=JSON.stringify(all);
   assert.match(json,/GENERATED_VISIBLE_TITLE/);assert.match(json,/GENERATED_VISIBLE_BODY/);assert.match(json,/GENERATED_VISIBLE_MEMORY/);
   assert.doesNotMatch(json,/GENERATED_HIDDEN_TITLE|GENERATED_HIDDEN_BODY|GENERATED_HIDDEN_MEMORY|GENERATED_MIXED_MEMORY|generated-hidden-path|generated-hidden-source/);
   assert.equal(sources.data.items.length,1);assert.equal(items.data.length,1);assert.equal(catalog.data.items.length,1);
   if(restriction==='withdrawal'||restriction==='source-withdrawal'){
    const withdrawn=await node.app.inject(restriction==='source-withdrawal'?{method:'PATCH',url:'/api/sources/generated-visible-source',headers,payload:{enabled:false}}:{method:'PUT',url:'/api/sources/generated-visible-source/items',headers,payload:{externalId:'generated-item',revision:'2',observedAt:'2026-10-03T00:00:00Z',title:'GENERATED_VISIBLE_TITLE',text:'',kind:'file',layer:'snapshot',deleted:true,document:{path:'generated-visible-path/public.txt',contentRole:'other',timeBasis:'unknown'}}});
    assert.equal(withdrawn.statusCode,200,withdrawn.body);
    const response=await fetch(bridge.url+'/material_read',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({ref:catalog.data.items[0].ref,length:12000})});
    const rejected=await response.json();assert.notEqual(response.status,200,JSON.stringify(rejected));assert.doesNotMatch(JSON.stringify(rejected),/GENERATED_VISIBLE_BODY|generated-visible-path/);
    const afterWithdrawal=await capability('sources');assert.deepEqual(afterWithdrawal.data.items,[],'a source no longer represented in the time range is not disclosed again');
   }
   return {answer:'Generated bounded result',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){fixtureFailure=error;throw error;}finally{await bridge.close();}
 }}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const api=(method:'POST'|'PUT',url:string,payload:unknown)=>node.app.inject({method,url,headers,payload:payload as any});
 const ids:string[]=[];
 for(const row of [
  {id:'generated-hidden-source',deviceId:restriction.endsWith('device')?'generated-hidden-device':'generated-shared-device',observedAt:sourceScoped&&restriction!=='source-time'?'2026-10-01T00:00:00Z':'2026-09-01T00:00:00Z',title:'GENERATED_HIDDEN_TITLE',text:'Generated scoped GENERATED_HIDDEN_BODY',path:'generated-hidden-path/private.txt'},
  {id:'generated-visible-source',deviceId:restriction.endsWith('device')?'generated-visible-device':'generated-shared-device',observedAt:'2026-10-01T00:00:00Z',title:'GENERATED_VISIBLE_TITLE',text:'Generated scoped GENERATED_VISIBLE_BODY',path:'generated-visible-path/public.txt'},
 ]){
  const created=await api('POST','/api/sources',{id:row.id,name:row.title,kind:'custom',deviceId:row.deviceId,platform:'import',retention:'archive'});assert.equal(created.statusCode,200,created.body);
  const saved=await api('PUT',`/api/sources/${row.id}/items`,{externalId:'generated-item',revision:'1',observedAt:row.observedAt,title:row.title,text:row.text,kind:'file',layer:'snapshot',document:{path:row.path,contentRole:'other',timeBasis:'unknown'}});assert.equal(saved.statusCode,200,saved.body);ids.push(saved.json().id);
  if(sourceScoped)await node.store.ingest({id:randomUUID(),deviceId:row.deviceId,deviceName:row.title,platform:'import',capturedAt:row.observedAt,durationMs:1000,source:'activity',appId:row.id,appName:row.title,ocrText:'',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
 }
 seedMemory(node,'GENERATED_HIDDEN_MEMORY',[ids[0]]);seedMemory(node,'GENERATED_VISIBLE_MEMORY',[ids[1]]);seedMemory(node,'GENERATED_MIXED_MEMORY',ids);
 await node.materialOrganizer.tick();
 if(sourceScoped){node.store.archive.aggregate();assert.equal(node.store.activity().captures,2,'unselected device activity exists in the generated archive');}
 if(sourceScoped){
  const conversation=(await node.app.inject({url:'/api/conversations/main',headers})).json();
  const intersection=restriction==='source-device'||restriction==='source-time';
  const admitted=await api('POST','/api/conversations/messages',{conversationId:conversation.id,clientRequestId:randomUUID(),question:'Generated source query',scope:{kind:'selection',sourceIds:intersection?['generated-visible-source','generated-hidden-source']:['generated-visible-source'],...(restriction==='source-device'?{deviceId:'generated-visible-device'}:{}),...(restriction==='source-time'?{after:'2026-09-15T00:00:00Z'}:{})}});
  assert.equal(admitted.statusCode,202,admitted.body);
  let message:any;const deadline=Date.now()+10000;
  do{message=(await node.app.inject({url:`/api/conversations/${conversation.id}/messages/${admitted.json().id}`,headers})).json();if(['completed','failed'].includes(message.status))break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
  if(fixtureFailure)throw fixtureFailure;
  assert.equal(message.status,restriction==='source-withdrawal'?'failed':'completed',JSON.stringify(message));
  return;
 }
 const scope=restriction==='device'?{deviceId:'generated-visible-device'}:{after:'2026-09-15T00:00:00Z'};
 const response=await api('POST','/api/query',{question:'Generated bounded query',...scope});
 if(fixtureFailure)throw fixtureFailure;
 assert.equal(response.statusCode,restriction==='withdrawal'?409:200,response.body);
});

test('time-scoped source pagination skips hidden rows without leaking their identities in cursors',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-source-pages-')),token='generated-source-pages-owner',headers={authorization:'Bearer '+token};
 let node!:Awaited<ReturnType<typeof buildApp>>,fixtureFailure:unknown;
 const cfg:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 node=await buildApp(cfg,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  const bridge=await startBridge(node.featureServices.archiveReader,input);
  try{
   const send=(tool:string,args:unknown)=>fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});
   const discovery=await send('capability_discover',{name:'sources'}),version=(await discovery.json() as any).data.version;
   const page=async(args:unknown)=>{const response=await send('capability_execute',{name:'sources',version,argumentsJson:JSON.stringify(args)});const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));return value.data;};
   const first=await page({limit:1});assert.deepEqual(first.items.map((item:any)=>item.id),['b-visible']);assert.equal(typeof first.nextCursor,'string');
   assert.doesNotMatch(Buffer.from(first.nextCursor,'base64url').toString(),/hidden/);
   const second=await page({limit:1,cursor:first.nextCursor});assert.deepEqual(second.items.map((item:any)=>item.id),['d-visible']);assert.equal(second.nextCursor,null);
   assert.doesNotMatch(JSON.stringify({first,second}),/HIDDEN|hidden/);
   const altered=await send('capability_execute',{name:'sources',version,argumentsJson:JSON.stringify({limit:1,query:'different',cursor:first.nextCursor})});assert.notEqual(altered.status,200,'a cursor cannot be reused for a different query');
   return {answer:'Generated paged response',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){fixtureFailure=error;throw error;}finally{await bridge.close();}
 }}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 for(const [id,visible] of [['a-hidden',false],['b-visible',true],['c-hidden',false],['d-visible',true],['e-hidden',false]] as const){
  const created=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id,name:visible?'Generated visible '+id:'GENERATED HIDDEN '+id,kind:'custom',deviceId:'generated-device',platform:'import'}});assert.equal(created.statusCode,200,created.body);
  const saved=await node.app.inject({method:'PUT',url:`/api/sources/${id}/items`,headers,payload:{externalId:'item',revision:'1',observedAt:visible?'2026-10-01T00:00:00Z':'2026-09-01T00:00:00Z',kind:'message',layer:'original',text:'Generated page item'}});assert.equal(saved.statusCode,200,saved.body);
 }
 const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated paged query',after:'2026-09-15T00:00:00Z'}});
 if(fixtureFailure)throw fixtureFailure;
 assert.equal(response.statusCode,200,response.body);
});
