import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentTimeoutError,calculateContextBudget,estimateSerializedTokens,type QueryInput} from '@mote/agent';
import {Store} from '../src/store.js';
import {Conversations} from '../src/conversations.js';
import {WorkingMemory} from '../src/working-memory.js';
import {defaultLifecycleSettings} from '../src/memory-lifecycle.js';

const result=(answer:string,ids:string[]=[])=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}});
const settings={...defaultLifecycleSettings,contextCharacters:4000,summaryCharacters:1000,recentTurns:1};

function fixture(t:test.TestContext){
 const dir=mkdtempSync(join(tmpdir(),'mote-working-c4-'));let store=new Store(dir);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const open=()=>{const conversations=new Conversations(store);return {store,conversations,working:new WorkingMemory(store,conversations)};};
 return {...open(),restart(){store.close();store=new Store(dir);return open();}};
}

test('absolute prefix boundary survives gaps and appends but not edits or deletion inside its covered range',async t=>{
 const {store,conversations,working}=fixture(t),id=conversations.main().id;
 for(let i=0;i<4;i++)conversations.append(conversations.get(id),{question:'Generated question '+i},result('Generated answer '+i));
 store.db.prepare('DELETE FROM conversation_turns WHERE conversation_id=? AND idx=1').run(id);
 const batches:string[][]=[];
 const summarize=async(input:QueryInput)=>{batches.push(input.taskContext!.turns.map(turn=>String(turn.question)));return result('Generated summary');};
 await working.compact(id,settings,summarize);
 assert.equal(working.get(conversations.get(id))?.coveredThroughSeq,2);
 const old=working.get(conversations.get(id));
 conversations.append(conversations.get(id),{question:'Generated later question'},result('Generated later answer'));
 assert.deepEqual(working.get(conversations.get(id)),old,'appending beyond the covered prefix does not invalidate it');
 await working.compact(id,settings,summarize);
 assert.equal(working.get(conversations.get(id))?.coveredThroughSeq,3);
 assert.deepEqual(batches,[['Generated question 0','Generated question 2'],['Generated question 3']]);
 store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.question','Generated changed question') WHERE conversation_id=? AND idx=2").run(id);
 assert.equal(working.get(conversations.get(id)),undefined);
 await working.compact(id,settings,summarize);
 store.db.prepare('DELETE FROM conversation_turns WHERE conversation_id=? AND idx=0').run(id);
 assert.equal(working.get(conversations.get(id)),undefined,'a deleted earlier turn cannot shift the absolute coverage boundary');
 assert.deepEqual(conversations.page(id,{limit:10}).turns.map(turn=>turn.seq),[2,3,4]);
});

test('small batches commit durable progress, retain the latest tail, and resume after timeout and restart',async t=>{
 const f=fixture(t);let {conversations,working}=f;const id=conversations.main().id;
 for(let i=0;i<7;i++)conversations.append(conversations.get(id),{question:'Generated question '+i},result('answer '+i+' '.repeat(5)+'x'.repeat(1400)));
 let calls=0;const first:string[]=[];
 await assert.rejects(working.compact(id,settings,async input=>{
   calls++;if(calls===2)throw new AgentTimeoutError();
   first.push(...input.taskContext!.turns.map(turn=>String(turn.question)));return result('Generated checkpoint');
 }),/timeout/i);
 const checkpoint=working.get(conversations.get(id));assert.ok(checkpoint);assert.ok(checkpoint.coveredThroughSeq<5);
 assert.equal(conversations.page(id,{limit:20}).turns.length,7,'all original turns remain pageable');
 ({conversations,working}=f.restart());
 assert.deepEqual(working.get(conversations.get(id)),checkpoint);
 const rest:string[]=[];await working.compact(id,settings,async input=>{assert.equal(input.taskContext?.previousSummary,'Generated checkpoint');rest.push(...input.taskContext!.turns.map(turn=>String(turn.question)));return result('Generated checkpoint');});
 assert.deepEqual([...first,...rest],Array.from({length:6},(_,i)=>'Generated question '+i));
 assert.equal(working.get(conversations.get(id))?.coveredThroughSeq,5);
 assert.deepEqual(working.context(conversations.get(id),settings).turns.map(turn=>turn.question),['Generated question 6']);
});

test('C1 history target and low watermark drive bounded compaction, while zero history budget never starts a model call',async t=>{
 const {conversations,working}=fixture(t),id=conversations.main().id;
 for(let i=0;i<8;i++)conversations.append(conversations.get(id),{question:'Generated '+i},result('generated '.repeat(70)));
 const budget=calculateContextBudget({contextWindow:1800,outputLimit:200,configuration:{historyRatio:.5,lowWatermarkRatio:.5},usage:{systemTokens:150,toolSchemaTokens:100,currentInputTokens:30,toolReserveTokens:50,historyTokens:0}});
 let calls=0;const context=await working.prepare(conversations.get(id),{...settings,contextCharacters:20000},'Continue',async()=>{calls++;return result('Generated compact summary');},undefined,budget);
 assert.ok(calls>0);assert.ok(context.turns.length>0,'the newest tail is retained when it fits');
 assert.ok(estimateSerializedTokens({turns:context.turns,workingMemory:context.workingMemory}).tokens<=budget.history.lowWatermark);
 const zero=calculateContextBudget({contextWindow:1000,outputLimit:200,configuration:{historyRatio:0},usage:{systemTokens:100,toolSchemaTokens:0,currentInputTokens:10,toolReserveTokens:0,historyTokens:0}});
 await assert.rejects(working.prepare(conversations.get(id),settings,'Continue',async()=>{assert.fail('zero history budget cannot compact');},undefined,zero),/budget/i);
 const empty=conversations.receive({question:'Generated empty conversation'}).conversationId;
 const noHistory=await working.prepare(conversations.get(empty),settings,'Continue',async()=>{assert.fail('zero history budget cannot compact');},undefined,zero);
 assert.deepEqual(noHistory.turns,[]);
 const overflow=calculateContextBudget({contextWindow:100,outputLimit:90,usage:{systemTokens:20,toolSchemaTokens:0,currentInputTokens:0,toolReserveTokens:0,historyTokens:0}});
 await assert.rejects(working.prepare(conversations.get(empty),settings,'Continue',async()=>{assert.fail('reserves cannot fit');},undefined,overflow),/budget/i);
});

test('explicit working-context reset survives restart, does not erase history, and rejects a late summary',async t=>{
 const f=fixture(t);let {conversations,working}=f;const id=conversations.main().id;
 conversations.append(conversations.get(id),{question:'Generated before reset'},result('Earlier answer'));
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
 const late=working.compact(id,{...settings,recentTurns:0},async()=>{entered();await wait;return result('Late summary');});
 await ready;working.reset(id);release();await assert.rejects(late,/changed|reset/i);
 conversations.append(conversations.get(id),{question:'Generated after reset'},result('Later answer'));
 ({conversations,working}=f.restart());
 assert.deepEqual(working.context(conversations.get(id),settings).turns.map(turn=>turn.question),['Generated after reset']);
 assert.deepEqual(conversations.page(id,{limit:10}).turns.map(turn=>turn.question),['Generated before reset','Generated after reset']);
 await working.compact(id,{...settings,recentTurns:0},async input=>{assert.deepEqual(input.taskContext!.turns.map(turn=>turn.question),['Generated after reset']);return result('New summary');});
 assert.equal(working.get(conversations.get(id))?.coveredThroughSeq,1);
});

test('explicit references and unread attachments remain dependencies through compaction, history read, and erasure',async t=>{
 const {createHash}=await import('node:crypto'),{default:sharp}=await import('sharp'),{buildApp}=await import('../src/app.js');
 const {withFixtureOwnerModelWork}=await import('./fixtures/model-authorization.js');
 const dir=mkdtempSync(join(tmpdir(),'mote-working-c4-lineage-')),token='generated-working-owner',headers={authorization:`Bearer ${token}`};
 const config={dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 let node!:Awaited<ReturnType<typeof buildApp>>,oldTurn='',observed=false;
 const agent={configured:true,close:async()=>{},query:async(input:QueryInput)=>{
   if(input.skill==='working-memory')return result('GENERATED_SUMMARY_WITH_REFERENCES',input.contextEvidenceDependencies?.ids);
   assert.match(input.conversation?.workingMemory?.text??'',/GENERATED_SUMMARY_WITH_REFERENCES/);
   const {startBridge}=await import('../../../packages/agent/dist/bridge.js'),bridge=await startBridge(node.featureServices.archiveReader,input);
   try{
     const response=await fetch(bridge.url+'/conversation_history',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:oldTurn})});
     const page=await response.json() as any;assert.equal(response.status,200,JSON.stringify(page));assert.equal(page.data.items[0].id,oldTurn);observed=true;
     return {...result('GENERATED_DOWNSTREAM_AFTER_READ'),trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
   }finally{await bridge.close();}
 }};
 node=await buildApp(config,{backgroundWorker:false,agent});t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
 const sourceId='generated-c4-upload';node.sources.register({id:sourceId,name:'Generated source',kind:'upload',deviceId:'generated',platform:'import',retention:'archive'});
 const original=randomUUID();await node.store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated quoted evidence'});
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),hash=createHash('sha256').update(bytes).digest('hex');
 const upload=node.files.begin({sourceId,item:{externalId:'image',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'GENERATED_ATTACHMENT',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:hash,sizeBytes:bytes.length},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const attachment=(await node.files.commit(upload.uploadId,()=>{})).captureId;
 const id=node.conversations.main().id;
 oldTurn=node.conversations.append(node.conversations.get(id),{question:'GENERATED_QUOTE from attached and referenced originals',anchorEvidenceIds:[original],attachments:[{id:attachment,name:'GENERATED_ATTACHMENT',mimeType:'image/png'}]},result('GENERATED_UPSTREAM',[])).turnId;
 const stored=node.conversations.get(id).turns[0];assert.ok(stored.result!.evidenceDependencies!.ids.includes(original));assert.ok(stored.result!.evidenceDependencies!.ids.includes(attachment));
 await withFixtureOwnerModelWork(node,()=>node.working.compact(id,{...settings,recentTurns:0},async input=>{
   assert.ok(input.contextEvidenceDependencies!.ids.includes(original));assert.ok(input.contextEvidenceDependencies!.ids.includes(attachment));
   assert.ok(input.historyContext!.evidenceDependencies.ids.includes(original));assert.ok(input.historyContext!.evidenceDependencies.ids.includes(attachment));
   return node.featureServices.queryAgent(input);
 }));
 const summary=node.working.get(node.conversations.get(id))!;assert.ok(summary.evidenceDependencies.ids.includes(original));assert.ok(summary.evidenceDependencies.ids.includes(attachment));
 const follow=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:id,question:'Read the earlier dialogue'}});assert.equal(follow.statusCode,200,follow.body);assert.equal(observed,true);
 const before=node.conversations.get(id),downstream=before.turns.at(-1)!;
 assert.ok(downstream.result!.evidenceDependencies!.ids.includes(original));assert.ok(downstream.result!.evidenceDependencies!.ids.includes(attachment));
 node.store.invalidateConversationAnswers([original],true);
 const after=node.conversations.get(id);assert.ok(after.turns.every(turn=>turn.evidenceDeleted));assert.equal(node.working.get(after),undefined);
 assert.doesNotMatch(JSON.stringify(after),/GENERATED_UPSTREAM|GENERATED_DOWNSTREAM_AFTER_READ/);
 const page=await node.app.inject({url:`/api/conversations/${id}?limit=10`,headers});assert.equal(page.statusCode,200);assert.equal(page.json().turns.length,2,'erasing derived answers does not remove original dialogue entries');
});

test('existing saved message references are included even if its answer did not record a read',async t=>{
 const {store,conversations,working}=fixture(t),original=randomUUID();
 await store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated old original'});
 const id=conversations.main().id,{turnId}=conversations.append(conversations.get(id),{question:'Generated quoted input',anchorEvidenceIds:[original]},result('Generated answer'));
 store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.result.evidenceDependencies.ids',json('[]'),'$.historyEvidenceDependencies.ids',json('[]')) WHERE id=?").run(turnId);
 await working.compact(id,{...settings,recentTurns:0},async input=>{assert.deepEqual(input.contextEvidenceDependencies!.ids,[original]);assert.deepEqual(input.historyContext!.evidenceDependencies.ids,[original]);return result('Generated tracked summary',[original]);});
 assert.deepEqual(working.get(conversations.get(id))!.evidenceDependencies.ids,[original]);
 store.delete(original);assert.equal(working.get(conversations.get(id)),undefined);
});

test('an append during compaction does not reject the unchanged covered prefix or consume the new tail',async t=>{
 const {conversations,working}=fixture(t),id=conversations.main().id;
 conversations.append(conversations.get(id),{question:'Generated covered input'},result('Generated covered answer'));
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
 const pending=working.compact(id,{...settings,recentTurns:0},async()=>{entered();await wait;return result('Generated summary');});
 await ready;conversations.append(conversations.get(id),{question:'Generated later tail'},result('Generated later answer'));release();await pending;
 assert.equal(working.get(conversations.get(id))?.coveredThroughSeq,0);
 assert.deepEqual(working.context(conversations.get(id),settings).turns.map(turn=>turn.question),['Generated later tail']);
});

test('successive batches retain all earlier evidence pins and use the conversation sequence index',async t=>{
 const {store,conversations,working}=fixture(t),id=conversations.main().id,ids:string[]=[];
 for(let i=0;i<3;i++){
   const original=randomUUID();ids.push(original);
   await store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated original '+i});
   conversations.append(conversations.get(id),{question:'Generated original '+i},result('Generated answer '+i,[original]));
   await working.compact(id,{...settings,recentTurns:0},async input=>{
     assert.equal(input.taskContext!.turns.length,1,'only the newly uncovered turn is sent');
     assert.deepEqual(new Set(input.contextEvidenceDependencies!.ids),new Set(ids));
     return result('Generated cumulative summary',ids);
   },i);
   assert.deepEqual(new Set(working.get(conversations.get(id))!.evidenceDependencies.ids),new Set(ids));
 }
 const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT idx,json FROM conversation_turns WHERE conversation_id=? AND idx<? ORDER BY idx DESC LIMIT ?').all(id,3,-1).map(row=>String(row.detail)).join(' ');
 assert.match(plan,/SEARCH conversation_turns USING (?:INDEX|PRIMARY KEY)/i);
});

test('an escaped summary that leaves no room for another span fails before another model call',async t=>{
 const {conversations,working}=fixture(t),id=conversations.main().id;
 conversations.append(conversations.get(id),{question:'Generated long turn'},result('x'.repeat(8000)));
 let calls=0;
 await assert.rejects(working.compact(id,{...settings,recentTurns:0},async input=>{
   calls++;assert.ok(JSON.stringify(input.taskContext).length<=settings.contextCharacters);
   return result('\u0001'.repeat(900));
 }),/budget/i);
 assert.equal(calls,1);assert.equal(working.get(conversations.get(id)),undefined);assert.equal(conversations.page(id,{limit:10}).turns[0].result!.answer.length,8000);
});

test('an older caller snapshot cannot delete a newer valid summary',async t=>{
 const {conversations,working}=fixture(t),id=conversations.main().id;
 conversations.append(conversations.get(id),{question:'Generated first turn'},result('Generated first answer'));
 const older=conversations.get(id);
 conversations.append(conversations.get(id),{question:'Generated second turn'},result('Generated second answer'));
 await working.compact(id,{...settings,recentTurns:0},async()=>result('Generated newer summary'));
 const current=working.get(conversations.get(id));assert.equal(current!.coveredThroughSeq,1);
 assert.equal(working.get(older),undefined);
 assert.deepEqual(working.get(conversations.get(id)),current);
});

test('a pinned Material reference without a tool read keeps its actual anchors and original dependencies',async t=>{
 const {MaterialStore,materialId}=await import('../src/materials.js');
 const {store,conversations,working}=fixture(t),materials=new MaterialStore(store),original=randomUUID();
 await store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated Material original'});
 const material=materials.publish({id:materialId('generated-c4','doc'),kind:'mote.note',schemaVersion:1,title:'Generated Material',origin:{sourceId:'generated-c4',externalId:'doc',deviceId:'generated'},members:[{id:original,kind:'capture',ref:'capture:'+original}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated Material original',memberIds:[original]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const anchor=materials.evidenceIds(material.ref)[0],id=conversations.main().id;
 conversations.append(conversations.get(id),{question:'Generated question about this Material',anchorMaterialRef:material.ref},result('Generated answer'));
 await working.compact(id,{...settings,recentTurns:0},async input=>{
   assert.ok(input.contextEvidenceDependencies!.ids.includes(anchor));assert.ok(input.contextEvidenceDependencies!.ids.includes(original));
   assert.ok(input.historyContext!.evidenceDependencies.ids.includes(anchor));assert.ok(input.historyContext!.evidenceDependencies.ids.includes(original));return result('Generated tracked Material summary',[anchor,original]);
 });
 assert.ok(working.get(conversations.get(id))!.evidenceDependencies.ids.includes(anchor));
 assert.ok(working.get(conversations.get(id))!.evidenceDependencies.ids.includes(original));
 store.invalidateMemoryEvidence(original);assert.equal(working.get(conversations.get(id)),undefined);
});

test('cancellation prevents a late model response from publishing a summary',async t=>{
 const {conversations,working}=fixture(t),id=conversations.main().id,controller=new AbortController();
 conversations.append(conversations.get(id),{question:'Generated cancellable turn'},result('Generated retained answer'));
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
 const pending=working.compact(id,{...settings,recentTurns:0},async()=>{entered();await wait;return result('Generated late answer');},undefined,{signal:controller.signal,commit:write=>write()});
 await ready;controller.abort();release();await assert.rejects(pending);
 assert.equal(working.get(conversations.get(id)),undefined);assert.equal(conversations.page(id,{limit:10}).turns[0].result!.answer,'Generated retained answer');
});

test('a slower competing compactor cannot overwrite a newer committed summary',async t=>{
 const {store,conversations,working}=fixture(t),id=conversations.main().id,other=new WorkingMemory(store,conversations);
 conversations.append(conversations.get(id),{question:'Generated concurrent turn'},result('Generated answer'));
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
 const slow=working.compact(id,{...settings,recentTurns:0},async()=>{entered();await wait;return result('Generated obsolete summary');});
 await ready;await other.compact(id,{...settings,recentTurns:0},async()=>result('Generated current summary'));release();
 await assert.rejects(slow,/changed/i);assert.equal(other.get(conversations.get(id))?.text,'Generated current summary');
});
