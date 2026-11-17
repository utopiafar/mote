import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {QueryInput} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {materialId} from '../src/materials.js';
const token='generated-light-entry-owner',headers={authorization:'Bearer '+token};
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
async function until<T>(read:()=>Promise<T|undefined>,label:string):Promise<T>{const end=Date.now()+10000;while(Date.now()<end){const value=await read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Generated light-entry timeout: '+label);}
async function fixture(t:any,afterRead:()=>Promise<void>=async()=>{},ordinaryControl=false){
 const directory=mkdtempSync(join(tmpdir(),'mote-chat-light-entry-')),seen:QueryInput[]=[],reads:string[]=[];let fixtureFailure:unknown;
 const config:ConfigurationPlatformOptions={path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:2_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-light-model',baseUrl:'https://generated.invalid',apiKey:'generated-only',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  seen.push(input);
  const bridge=await startBridge(reader,input);
  const send=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json() as any};};
  try{
   if(ordinaryControl&&input.hostToolSelection===undefined){
    assert.ok(input.openingMemories?.some(memory=>memory.statement.includes('GENERATED_STANDING_MEMORY')),'ordinary fromMaterial retains its current opening Memory');
    return {answer:'Generated ordinary Material control',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:input.contextEvidenceDependencies};
   }
   assert.deepEqual(input.hostToolSelection,['material_read','evidence']);assert.deepEqual(input.openingMemories,[]);
   assert.equal(input.conversation?.turns.length??0,0,'unrelated main-conversation history is not included');
   assert.equal(input.evidenceIds,undefined,'a many-block Material remains one pinned selection');
   const page=await send('material_read',{ref:input.anchorMaterialRef,length:12000});assert.equal(page.status,200,JSON.stringify(page));reads.push(page.body.data.material.ref);
   assert.match(page.body.data.text,/GENERATED_SELECTED_BODY/);assert.doesNotMatch(JSON.stringify(page),/GENERATED_UNSELECTED_BODY/);
   const catalog=await send('material_catalog',{});assert.notEqual(catalog.status,200,'single-Material entry does not expose other records through the catalog');
   const search=await send('search_context',{query:'Generated'});assert.notEqual(search.status,200,'the entry does not silently add general archive research');
   const other=await send('material_read',{ref:unselectedRef,length:12000});assert.notEqual(other.status,200,'even a known ref from the same source was not selected');
   for(const id of new Set([unselected.original.id,...node.materials.evidenceIds(unselectedRef)])){
    const rawOther=await send('evidence',{ids:[id]});assert.notEqual(rawOther.status,200,'a known original or Material evidence ID from the same source cannot bypass the selected pin');
   }
   const original=page.body.data.sourceEvidence?.[0];assert.ok(original?.id,JSON.stringify(page.body.data));
   const raw=await send('evidence',{ids:[original.id]});assert.equal(raw.status,200,JSON.stringify(raw));
   await afterRead();
   return {answer:'Generated acquaintance: selected facts only.',citations:[{id:original.id,capturedAt:original.capturedAt,appName:original.appName??'Generated source',excerpt:original.ocrText.slice(0,40)}],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){fixtureFailure=error;throw error;}finally{await bridge.close();}
 }})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:unknown)=>node.app.inject({method,url,headers,...(payload===undefined?{}:{payload:payload as any})});
 const sourceId='generated-acquaintance-source';
 assert.equal((await api('POST','/api/sources',{id:sourceId,name:'Generated acquaintance source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'})).statusCode,200);
 const publish=async(externalId:string,revision:string,text:string)=>{
  const saved=await api('PUT',`/api/sources/${sourceId}/items`,{externalId,revision,observedAt:'2026-10-01T00:00:00Z',title:externalId,text,kind:'file',layer:'snapshot',document:{path:externalId+'.txt',contentRole:'other',timeBasis:'unknown'}});assert.equal(saved.statusCode,200,saved.body);
  await node.materialOrganizer.tick();
  const list=(await api('GET','/api/materials?sourceId='+sourceId)).json().items as {ref:string;origin:{externalId:string}}[];
  const material=list.find(value=>value.origin.externalId===externalId);assert.ok(material);return {material,original:saved.json()};
 };
 const selected=await publish('selected','v1','GENERATED_SELECTED_BODY '+Array.from({length:31},(_,n)=>'Generated fact '+n).join('\n\n'));
 const unselected=await publish('unselected','v1','GENERATED_UNSELECTED_BODY');const unselectedRef=unselected.material.ref;
 const main=(await api('GET','/api/conversations/main')).json();
 const post=(ref=selected.material.ref,requestId=randomUUID())=>api('POST','/api/conversations/messages',{conversationId:main.id,clientRequestId:requestId,question:'Generated owner acquaintance request',scope:{kind:'selection',sourceIds:[sourceId]},anchorMaterialRef:ref});
 const message=(id:string)=>api('GET',`/api/conversations/${main.id}/messages/${id}`).then(response=>response.json());
 const finish=(id:string)=>until(async()=>{const value=await message(id);if(['completed','failed','cancelled'].includes(value.status)){if(fixtureFailure)throw fixtureFailure;return value;}},'message settlement');
 return {node,api,post,message,finish,publish,selected,unselected,main,sourceId,seen,reads};
}

test('owner Material acquaintance retains its exact pin and reads only that Material through the actual bounded tool transport',async t=>{
 const f=await fixture(t),requestId=randomUUID(),response=await f.post(undefined,requestId);assert.equal(response.statusCode,202,response.body);
 const message=await f.finish(response.json().id);assert.equal(message.status,'completed',JSON.stringify(message));assert.equal(f.seen.length,1);assert.deepEqual(f.reads,[f.selected.material.ref]);
 assert.deepEqual(message.scope.sourceIds,[f.sourceId]);assert.equal(message.anchorMaterialRef,f.selected.material.ref);
 const conversation=f.node.conversations.get(f.main.id),turn=conversation.turns.find(turn=>turn.id===message.id)!;
 assert.equal(turn.scope.kind,'selection');assert.equal(turn.scope.anchorMaterialRef,f.selected.material.ref);assert.match(turn.result!.answer,/selected facts only/);
 assert.equal((await f.post(undefined,requestId)).statusCode,202);assert.equal(f.seen.length,1,'same owner message is not redelivered');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.onboarding'").get()!.n,0);
});

test('a stale Material pin is rejected without silently selecting its replacement',async t=>{
 const f=await fixture(t);const next=await f.publish('selected','v2','GENERATED_SELECTED_BODY changed revision');assert.notEqual(next.material.ref,f.selected.material.ref);
 const response=await f.post();assert.equal(response.statusCode,409,response.body);assert.equal(f.seen.length,0);
});

test('cancelled acquaintance retains the owner message and rejects a late controlled answer',async t=>{
 const entered=deferred(),held=deferred();t.after(()=>held.release());const f=await fixture(t,async()=>{entered.release();await held.promise;});
 const admitted=await f.post();assert.equal(admitted.statusCode,202,admitted.body);await entered.promise;
 const cancelled=await f.api('POST',`/api/conversations/${f.main.id}/messages/${admitted.json().id}/cancel`);assert.equal(cancelled.statusCode,200,cancelled.body);held.release();
 const message=await f.finish(admitted.json().id);assert.equal(message.status,'cancelled');assert.equal(message.question,'Generated owner acquaintance request');
 const turn=f.node.conversations.get(f.main.id).turns.find(turn=>turn.id===message.id)!;assert.equal(turn.result,undefined);assert.equal(f.seen.length,1);
});

test('a Material-only message excludes existing unpinned and other-pin history and opening Memory while ordinary fromMaterial retains Memory',async t=>{
 const f=await fixture(t,undefined,true),original=f.node.store.evidence([f.selected.original.id])[0];assert.ok(original);
 const raw={answer:JSON.stringify({memories:[{title:'Generated standing Memory',statement:`GENERATED_STANDING_MEMORY [${original.id}]`,uncertainty:'Generated fixture',contextPriority:'standing',admission:{layer:'memory',scope:'Only this generated source',reason:'Generated owner statement',attribution:'user'},evidenceIds:[original.id]}]}),citations:[{id:original.id,capturedAt:original.capturedAt,appName:'Generated source',excerpt:original.ocrText}],trace:[],runId:randomUUID()};
 const draft=f.node.memories.extract(fixtureMemoryResult(f.node.memories,raw),'generated').items[0];assert.ok(draft);f.node.memories.publish(draft.id,draft.version);
 const control=await f.api('POST','/api/query-runs',{id:randomUUID(),input:{question:'Generated ordinary Material control',anchorMaterialRef:f.selected.material.ref}});assert.equal(control.statusCode,202,control.body);
 const ordinary=await until(async()=>{const response=await f.api('GET','/api/query-runs/'+control.json().id),value=response.json();return value.status==='running'?undefined:value;},'ordinary Material control');assert.equal(ordinary.status,'completed',JSON.stringify(ordinary));
 for(const scope of [{kind:'all' as const},{kind:'selection' as const,sourceIds:[f.sourceId],anchorMaterialRef:f.unselected.material.ref}]){
  const message=f.node.conversations.receive({conversationId:f.main.id,question:'GENERATED_UNRELATED_HISTORY',...scope});
  f.node.conversations.complete(message.id,{answer:'GENERATED_UNRELATED_HISTORY answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}},{expectedVersion:message.version});
 }
 const admitted=await f.post();assert.equal(admitted.statusCode,202,admitted.body);const message=await f.finish(admitted.json().id);assert.equal(message.status,'completed',JSON.stringify(message));
 assert.equal(f.seen.length,2);const input=f.seen[1];assert.doesNotMatch(JSON.stringify(input),/GENERATED_UNRELATED_HISTORY|GENERATED_STANDING_MEMORY/);assert.deepEqual(input.openingMemories,[]);
 assert.equal(f.node.conversations.get(f.main.id).turns.filter(turn=>turn.question==='GENERATED_UNRELATED_HISTORY').length,2,'excluded history remains stored');
});

test('a source revoked before admission cannot grant a Material-only message',async t=>{
 const f=await fixture(t);f.node.sources.update(f.sourceId,{enabled:false});
 const response=await f.post();assert.equal(response.statusCode,409,response.body);assert.equal(f.seen.length,0);
});

test('revocation after a real Material read prevents publication of the late answer',async t=>{
 const entered=deferred(),held=deferred();t.after(()=>held.release());const f=await fixture(t,async()=>{entered.release();await held.promise;});
 const response=await f.post();assert.equal(response.statusCode,202,response.body);await entered.promise;f.node.sources.update(f.sourceId,{enabled:false});held.release();
 const message=await f.finish(response.json().id);assert.equal(message.status,'failed',JSON.stringify(message));assert.equal(message.result,undefined);assert.equal(f.seen.length,1);assert.deepEqual(f.reads,[f.selected.material.ref]);
 assert.equal(f.node.conversations.get(f.main.id).turns.find(turn=>turn.id===message.id)?.result,undefined);
});

test('a Material with members from another source does not bypass their current read authorization',async t=>{
 const f=await fixture(t),otherSource='generated-other-origin';f.node.sources.register({id:otherSource,name:'Generated other origin',kind:'custom',deviceId:'generated-device',platform:'import'});
 const other=await f.api('PUT',`/api/sources/${otherSource}/items`,{externalId:'other',revision:'v1',observedAt:'2026-10-01T00:00:00Z',title:'Other origin',text:'GENERATED_UNAUTHORIZED_MEMBER',kind:'message',layer:'original'});assert.equal(other.statusCode,200,other.body);
 const ids=[f.selected.original.id,other.json().id],id=materialId(f.sourceId,'mixed-origin');
 const material=f.node.materials.publish({id,kind:'mote.file',schemaVersion:1,title:'Generated mixed origin',origin:{sourceId:f.sourceId,externalId:'mixed-origin',deviceId:'generated-device'},members:ids.map(id=>({id,kind:'capture' as const,ref:'capture:'+id})),blocks:ids.map((id,index)=>({id:'generated-'+index,kind:'text' as const,format:'plain',text:index?'GENERATED_UNAUTHORIZED_MEMBER':'GENERATED_SELECTED_BODY',memberIds:[id]})),coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 assert.equal(f.node.store.delete(other.json().id).deleted,1,'remove the other member through the real original-deletion transaction');
 const response=await f.post(material.ref);assert.equal(response.statusCode,409,response.body);assert.equal(f.seen.length,0);
});
