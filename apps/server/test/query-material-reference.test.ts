import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId} from '../src/materials.js';

const token='generated-material-reference-owner',headers={authorization:'Bearer '+token};
async function fixture(t:TestContext,afterRead?:()=>Promise<void>,onClose?:()=>void){
 const directory=mkdtempSync(join(tmpdir(),'mote-material-reference-')),seen:QueryInput[]=[],readRefs:string[]=[];
 const config:Config={dataDir:directory,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const build=()=>buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{onClose?.();},query:async input=>{
  seen.push(input);let original:{id:string;capturedAt:string;appName?:string;ocrText:string}|undefined;
  if(input.anchorMaterialRef){
   assert.equal(input.evidenceIds,undefined);assert.equal(input.anchorEvidenceIds,undefined);
   assert.ok(reader.materialRead);
   const page=await reader.materialRead({ref:input.anchorMaterialRef,deviceId:input.deviceId,after:input.after,before:input.before,length:12000});
   assert.equal(page.material.ref,input.anchorMaterialRef);readRefs.push(page.material.ref);
   const locator=page.originalRefs[0];if(locator){const id=locator.slice('capture:'.length);original=(await reader.evidence({ids:[id]}))[0];}
  }
  await afterRead?.();
  return {answer:'Generated controlled reference answer',runId:randomUUID(),trace:[],citations:original?[{id:original.id,capturedAt:original.capturedAt,appName:original.appName??'Generated original',excerpt:original.ocrText.slice(0,40)}]:[],evidenceDependencies:{version:1 as const,complete:true,ids:original?[original.id]:[]}};
 }})});
 let node=await build();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.sources.register({id:'generated-material-reference',name:'Generated reference source',kind:'custom',deviceId:'generated-device',platform:'import'});
 async function publish(parts=31,state:'complete'|'partial'='complete',label='Original'){
  const id=randomUUID(),text=Array.from({length:parts},(_,index)=>label+' generated paragraph '+index).join('\n\n');
  const note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',capturedAt:'2026-10-01T00:00:00Z',text}});assert.equal(note.statusCode,201,note.body);
  const material=node.materials.publish({id:materialId('generated-material-reference','one'),kind:'mote.file',schemaVersion:1,title:'Generated long file',origin:{sourceId:'generated-material-reference',externalId:'one',deviceId:'generated-device',firstAt:'2026-10-01T00:00:00Z',lastAt:'2026-10-01T00:00:00Z'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:text.split('\n\n').map((part,index)=>({id:'paragraph-'+index,kind:'text' as const,format:'plain',text:part,memberIds:[id]})),coverage:{state,...(state==='partial'?{reason:'generated_unavailable_tail'}:{})},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:node.materials.revisionForWrite(materialId('generated-material-reference','one'))});
  return {id,text,material};
 }
 const request=(input:object,id=randomUUID())=>node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input}});
 async function finish(id:string){const until=Date.now()+10000;while(Date.now()<until){const response=await node.app.inject({url:'/api/query-runs/'+id,headers});assert.equal(response.statusCode,200,response.body);const run=response.json();if(run.status!=='running')return run;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Generated reference query did not settle');}
 return {get node(){return node;},seen,readRefs,publish,request,finish,restart:async()=>{await node.app.close();node=await build();}};
}

test('one exact Material locator admits 31 blocks through real query preparation and original reader, persists and inherits across restart',async t=>{
 const f=await fixture(t),selected=await f.publish();assert.equal(f.node.materials.evidenceIds(selected.material.ref).length,31);
 const id=randomUUID(),input={question:'Generated long-file question',anchorMaterialRef:selected.material.ref};
 const response=await f.request(input,id);assert.equal(response.statusCode,202,response.body);const first=await f.finish(id);assert.equal(first.status,'completed',JSON.stringify(first));
 assert.equal(f.seen.length,1);assert.equal(f.seen[0].anchorMaterialRef,selected.material.ref);assert.deepEqual(f.readRefs,[selected.material.ref]);assert.equal(f.seen[0].evidenceIds,undefined);assert.equal(f.seen[0].anchorEvidenceIds,undefined);
 const conversation=f.node.conversations.get(first.conversationId);assert.equal(conversation.scope.anchorMaterialRef,selected.material.ref);assert.equal(conversation.turns[0].scope.anchorMaterialRef,selected.material.ref);const cited=conversation.turns[0].result!.citations[0];assert.ok(f.node.materials.evidenceIds(selected.material.ref).includes(cited.id));assert.equal(cited.excerpt,'Original generated paragraph 0');assert.ok(conversation.turns[0].historyEvidenceDependencies?.ids.includes(selected.id),'retained permission roots include the actual source original');
 assert.equal((await f.request(input,id)).statusCode,202);assert.equal(f.seen.length,1,'same admitted request is never submitted twice');assert.equal((await f.request({...input,question:'Changed question'},id)).statusCode,409);
 await f.restart();const follow=await f.request({question:'Generated inherited follow-up',conversationId:first.conversationId});assert.equal(follow.statusCode,202,follow.body);assert.equal((await f.finish(follow.json().id)).status,'completed');assert.equal(f.seen.at(-1)?.anchorMaterialRef,selected.material.ref);
 const clear=await f.request({question:'Generated explicit reference clear',conversationId:first.conversationId,anchorMaterialRef:null});assert.equal(clear.statusCode,202,clear.body);const last=await f.finish(clear.json().id);assert.equal(last.status,'completed');assert.equal(f.seen.at(-1)?.anchorMaterialRef,undefined);assert.equal(f.node.conversations.get(first.conversationId).scope.anchorMaterialRef,undefined);
});

test('invalid, mixed, mismatched-scope, stale and retired references reject before model admission without selecting a replacement',async t=>{
 const f=await fixture(t),selected=await f.publish();
 for(const input of [{question:'Invalid',anchorMaterialRef:selected.material.id},{question:'Mixed',anchorMaterialRef:selected.material.ref,anchorEvidenceIds:[selected.id]},{question:'Mixed strict',anchorMaterialRef:selected.material.ref,evidenceIds:[selected.id]}])assert.equal((await f.request(input)).statusCode,400);
 assert.equal((await f.request({question:'Different device',anchorMaterialRef:selected.material.ref,deviceId:'other-device'})).statusCode,409);
 assert.equal((await f.request({question:'Outside time',anchorMaterialRef:selected.material.ref,after:'2026-10-02T00:00:00Z'})).statusCode,409);
 const next=await f.publish(31,'complete','Replacement');assert.notEqual(next.material.ref,selected.material.ref);assert.equal((await f.request({question:'Stale',anchorMaterialRef:selected.material.ref})).statusCode,409);
 f.node.materials.retire(next.material.id,{expectedRevision:next.material.revision});assert.equal((await f.request({question:'Retired',anchorMaterialRef:next.material.ref})).statusCode,409);assert.equal(f.seen.length,0);
});

test('a readable partial Material preserves its existing coverage instead of imposing a new Memory-readiness rule',async t=>{
 const f=await fixture(t),selected=await f.publish(2,'partial');
 const response=await f.request({question:'Generated partial file question',anchorMaterialRef:selected.material.ref});assert.equal(response.statusCode,202,response.body);assert.equal((await f.finish(response.json().id)).status,'completed');assert.equal(f.seen[0].anchorMaterialRef,selected.material.ref);assert.equal(f.node.materials.get(selected.material.ref)?.coverage.state,'partial');
});

test('a revision change after an admitted read fences publication and retains a failed question instead of returning the new body',{timeout:15000},async t=>{
 let entered!:()=>void,release!:()=>void;const reading=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const f=await fixture(t,async()=>{entered();await gate;},release);t.after(()=>release());const selected=await f.publish();
 const response=await f.request({question:'Generated revision race',anchorMaterialRef:selected.material.ref});assert.equal(response.statusCode,202,response.body);await reading;
 const next=await f.publish(31,'complete','Changed while running');assert.notEqual(next.material.ref,selected.material.ref);release();
 const run=await f.finish(response.json().id);assert.equal(run.status,'failed',JSON.stringify(run));assert.deepEqual(f.readRefs,[selected.material.ref]);assert.equal(f.seen.length,1);
 const conversation=f.node.conversations.get(run.conversationId);assert.equal(conversation.turns[0].question,'Generated revision race');assert.equal(conversation.turns[0].scope.anchorMaterialRef,selected.material.ref);assert.equal(conversation.turns[0].result,undefined);
});
