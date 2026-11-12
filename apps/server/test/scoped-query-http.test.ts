import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ContextReader,QueryInput} from '@mote/agent';
import {sha256} from '../src/store.js';
const headers={authorization:'Bearer generated-scoped-owner-token'};
async function fixture(t:TestContext,query:QueryAgent['query'],captureReader?:(reader:ContextReader)=>void){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-scoped-query-'));
 const config:Config={dataDir,token:'generated-scoped-owner-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const build=()=>buildApp(config,{backgroundWorker:false,...(captureReader?{createModelAgent:async(_settings:unknown,reader:ContextReader)=>{captureReader(reader);return {configured:true,query,close:async()=>{}};}}:{agent:{configured:true,query,close:async()=>{}}})});let current=await build();
 t.after(async()=>{await current.app.close();rmSync(dataDir,{recursive:true,force:true});});return {get node(){return current;},restart:async()=>{await current.app.close();current=await build();}};
}
async function add(node:Awaited<ReturnType<typeof buildApp>>,deviceId='generated-device'){
 const note={id:randomUUID(),deviceId,deviceName:'Generated fixture',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated owner comment',metadata:{version:1,observedAt:'2026-10-01T00:00:00Z',noteOrigin:{kind:'share',text:'Generated quoted external original'}}};
 const r=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:note});assert.equal(r.statusCode,201,r.body);await node.materialOrganizer.tick(100);return note;
}
const answer=(input:QueryInput)=>({answer:'Generated scoped answer',citations:(input.evidenceIds??[]).map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated fixture',excerpt:'Generated owner comment'})),trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:input.evidenceIds??[]}});
async function completed(node:Awaited<ReturnType<typeof buildApp>>,id:string){const deadline=Date.now()+10000;while(Date.now()<deadline){const run=(await node.app.inject({url:'/api/query-runs/'+id,headers})).json();if(run.status!=='running')return run;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated query did not settle');}

test('public selected evidence persists through runs, restart and inherited follow-ups; explicit null restores normal retrieval',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{seen.push(input);const result=answer(input);if(input.evidenceIds){const {evidenceDependencies:_,...withoutModelLineage}=result;return withoutModelLineage;}return result;});const selected=await add(f.node),other=await add(f.node,'generated-other');
 const id=randomUUID(),payload={id,input:{question:'Generated selected original question',evidenceIds:[selected.id]}};
 const admitted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload});assert.equal(admitted.statusCode,202,admitted.body);const first=await completed(f.node,id);assert.equal(first.status,'completed',JSON.stringify(first));
 assert.deepEqual(seen[0].evidenceIds,[selected.id]);assert.deepEqual(seen[0].openingMemories,[]);assert.deepEqual(seen[0].contextEvidenceDependencies?.ids,[selected.id]);assert.ok(seen[0].processingEvidence?.[selected.id]);assert.ok(!seen[0].contextEvidenceDependencies?.ids.includes(other.id));
 assert.deepEqual(f.node.delegation.get('query:'+id).scope.evidenceIds,[selected.id]);
 const conversation=(await f.node.app.inject({url:'/api/conversations/'+first.conversationId,headers})).json();assert.deepEqual(conversation.scope.evidenceIds,[selected.id]);assert.deepEqual(conversation.turns[0].scope.evidenceIds,[selected.id]);assert.ok(conversation.turns[0].result.evidenceDependencies.ids.includes(selected.id),'host selection lineage survives a model boundary omitting an optional receipt');
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload})).statusCode,202);assert.equal(seen.length,1);
 await f.restart();
 const follow=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated follow-up',conversationId:first.conversationId}});assert.equal(follow.statusCode,200,follow.body);assert.deepEqual(seen.at(-1)!.evidenceIds,[selected.id]);assert.equal(seen.at(-1)!.conversation?.turns.length,1);
 const clear=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated explicit clear',conversationId:first.conversationId,evidenceIds:null}});assert.equal(clear.statusCode,200,clear.body);assert.equal(seen.at(-1)!.evidenceIds,undefined);
 assert.equal((await f.node.app.inject({url:'/api/conversations/'+first.conversationId,headers})).json().scope.evidenceIds,undefined);
 const changed=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated narrower replacement',conversationId:first.conversationId,evidenceIds:[other.id]}});assert.equal(changed.statusCode,200,changed.body);assert.deepEqual(seen.at(-1)!.evidenceIds,[other.id]);assert.equal(seen.at(-1)!.conversation?.turns.length,0,'narrow selection cannot disclose earlier differently-scoped or unscoped dialogue');
 const normal=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated ordinary query'}});assert.equal(normal.statusCode,200,normal.body);assert.equal(seen.at(-1)!.evidenceIds,undefined);
});

test('invalid, missing and out-of-scope originals never reach a model; model citations cannot escape exact selection',async t=>{
 let calls=0,unrelated='';const f=await fixture(t,async input=>{calls++;return {...answer(input),citations:[{id:unrelated,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated unrelated',excerpt:'Not selected'}]};});const selected=await add(f.node),other=await add(f.node,'generated-other');unrelated=other.id;
 for(const evidenceIds of [[],[selected.id,selected.id],Array.from({length:31},()=>randomUUID())])assert.equal((await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated invalid selection',evidenceIds}})).statusCode,400);
 for(const scope of [{evidenceIds:[randomUUID()]},{evidenceIds:[selected.id],deviceId:'generated-other'},{evidenceIds:[selected.id],after:'2026-10-02T00:00:00Z'}]){const r=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated inaccessible selection',...scope}});assert.equal(r.statusCode,409,r.body);}
 assert.equal(calls,0);const escaped=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated selected query',evidenceIds:[selected.id]}});assert.equal(escaped.statusCode,409,escaped.body);assert.equal(calls,1);
});

test('selected deletion and cancellation fence late answers without publishing their text',async t=>{
 for(const mode of ['delete','cancel'] as const)await t.test(mode,async sub=>{
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;});
  const f=await fixture(sub,async input=>{entered();await gate;return {...answer(input),answer:'Generated late selected answer'};});sub.after(()=>release());const selected=await add(f.node),id=randomUUID();
  assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated blocked scoped query',evidenceIds:[selected.id]}}})).statusCode,202);await started;
  if(mode==='delete')assert.equal((await f.node.app.inject({method:'DELETE',url:'/api/notes/'+selected.id,headers})).statusCode,200);else assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs/'+id+'/cancel',headers,payload:{}})).statusCode,200);
  release();const run=await completed(f.node,id);assert.notEqual(run.status,'completed',JSON.stringify(run));const history=(await f.node.app.inject({url:'/api/conversations',headers})).json();for(const summary of history.items){const conversation=(await f.node.app.inject({url:'/api/conversations/'+summary.id,headers})).json();assert.ok(!JSON.stringify(conversation).includes('Generated late selected answer'));}
 });
});


test('A-only scoped follow-up excludes prior B-derived text until image B is explicitly attached again',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{
  seen.push(input);const images=input.directImages?.map(image=>image.id)??[];
  return {...answer(input),answer:images.length?'Generated B-derived historical prose':'Generated A-only answer',evidenceDependencies:{version:1,complete:true,ids:[...(input.evidenceIds??[]),...images]}};
 });
 const selected=await add(f.node);
 f.node.sources.register({id:'generated-scope-image',name:'Generated scope image',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#554488'}}).png().toBuffer();
 const upload=f.node.files.begin({sourceId:'generated-scope-image',item:{externalId:'generated-image-b',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated image B',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length},()=>{});
 f.node.files.part(upload.uploadId,0,bytes,()=>{});const attachment=(await f.node.files.commit(upload.uploadId,()=>{})).captureId;
 const first=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated selected A with image B',evidenceIds:[selected.id],attachmentIds:[attachment]}});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId;
 const second=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated A-only follow-up',conversationId}});assert.equal(second.statusCode,200,second.body);
 assert.deepEqual(seen.at(-1)!.evidenceIds,[selected.id]);assert.deepEqual(seen.at(-1)!.directImages,[]);
 assert.equal(seen.at(-1)!.conversation?.turns.length,0,'earlier B-derived answer and its attachment lineage are excluded from current A-only context');
 const third=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated A with B explicitly reattached',conversationId,attachmentIds:[attachment]}});assert.equal(third.statusCode,200,third.body);
 assert.deepEqual(seen.at(-1)!.directImages?.map(image=>image.id),[attachment]);
 assert.ok(seen.at(-1)!.conversation?.turns.some(turn=>turn.answer==='Generated B-derived historical prose'),'current explicit B authorization permits the prior A+B turn again');
});

test('record anchors retain archive retrieval, persist across restart and follow-ups, and transition explicitly to strict scope',async t=>{
 let reader!:ContextReader,anchorId='',otherId='';const seen:QueryInput[]=[];
 const f=await fixture(t,async input=>{
  seen.push(input);
  const ids=input.evidenceIds??[anchorId,otherId],originals=await reader.evidence({ids});
  assert.deepEqual(new Set(originals.map(record=>record.id)),new Set(ids),'the production reader permits both the starting record and other authorized originals');
  input.onEvidence?.(originals);
  const cited=originals.find(record=>record.id===otherId)!;
  return {...answer(input),answer:'Generated comparison with another original',citations:[{id:cited.id,capturedAt:cited.capturedAt,appName:cited.appName,excerpt:cited.ocrText}],evidenceDependencies:{version:1,complete:true,ids:[cited.id]}};
 },value=>{reader=value;});
 const anchor=await add(f.node),other=await add(f.node,'generated-other');anchorId=anchor.id;otherId=other.id;
 const id=randomUUID(),payload={id,input:{question:'Compare this record with related context',anchorEvidenceIds:[anchor.id]}};
 const admitted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload});assert.equal(admitted.statusCode,202,admitted.body);
 const first=await completed(f.node,id);assert.equal(first.status,'completed',JSON.stringify(first));
 assert.deepEqual(seen[0].anchorEvidenceIds,[anchor.id]);assert.equal(seen[0].evidenceIds,undefined);assert.ok(seen[0].processingEvidence?.[anchor.id]);
 assert.ok(seen[0].contextEvidenceDependencies?.ids.includes(anchor.id),'the anchor is a revocable dependency even before its body is read');
 assert.deepEqual(f.node.delegation.get('query:'+id).scope.anchorEvidenceIds,[anchor.id]);
 const conversation=()=>f.node.app.inject({url:'/api/conversations/'+first.conversationId,headers});
 const saved=(await conversation()).json();assert.deepEqual(saved.scope.anchorEvidenceIds,[anchor.id]);assert.deepEqual(saved.turns[0].scope.anchorEvidenceIds,[anchor.id]);
 assert.deepEqual(new Set(saved.turns[0].result.evidenceDependencies.ids),new Set([anchor.id,other.id]),'host anchor lineage survives a model receipt listing only its other cited original');
 assert.equal(saved.turns[0].result.citations[0].id,other.id,'an anchor does not confine citations to itself');
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload})).statusCode,202);assert.equal(seen.length,1);
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{...payload.input,anchorEvidenceIds:[other.id]}}})).statusCode,409,'an accepted run cannot be rewritten as a different reference selection');assert.equal(seen.length,1);
 await f.restart();
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload})).statusCode,202);assert.equal(seen.length,1,'restart preserves the completed run receipt');
 const query=async(input:Record<string,unknown>)=>{const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:first.conversationId,...input}});assert.equal(response.statusCode,200,response.body);return seen.at(-1)!;};
 const inherited=await query({question:'Continue comparing related originals'});assert.deepEqual(inherited.anchorEvidenceIds,[anchor.id]);assert.equal(inherited.evidenceIds,undefined);assert.equal(inherited.conversation?.turns.length,1);
 const strict=await query({question:'Only use the other original',evidenceIds:[other.id]});assert.deepEqual(strict.evidenceIds,[other.id]);assert.equal(strict.anchorEvidenceIds,undefined);assert.equal(strict.conversation?.turns.length,0,'strict selection excludes earlier answers using the anchor and other originals');
 const referenced=await query({question:'Return to automatic context retrieval',anchorEvidenceIds:[anchor.id]});assert.equal(referenced.evidenceIds,undefined);assert.deepEqual(referenced.anchorEvidenceIds,[anchor.id]);
 const cleared=await query({question:'Clear the reference record',anchorEvidenceIds:null});assert.equal(cleared.anchorEvidenceIds,undefined);assert.equal(cleared.evidenceIds,undefined);assert.equal((await conversation()).json().scope.anchorEvidenceIds,undefined);
 await query({question:'Use an explicit strict record again',evidenceIds:[other.id]});
 const onlyAnchorCleared=await query({question:'Clear references without changing my strict selection',anchorEvidenceIds:null});assert.deepEqual(onlyAnchorCleared.evidenceIds,[other.id]);assert.equal(onlyAnchorCleared.anchorEvidenceIds,undefined);
 const ordinary=await query({question:'Clear the explicit strict selection',evidenceIds:null});assert.equal(ordinary.evidenceIds,undefined);assert.equal(ordinary.anchorEvidenceIds,undefined);
});

test('invalid, missing, out-of-time, out-of-device and undisclosable record anchors are refused before model admission',async t=>{
 let calls=0;const f=await fixture(t,async input=>{calls++;return answer(input);});const anchor=await add(f.node);
 f.node.sources.register({id:'generated-withdrawn-source',name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
 const sourceItem={externalId:'event-1',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated withdrawn original',text:'Generated archived original from a withdrawn source item',kind:'message',layer:'original'};
 const restricted=(await f.node.sources.upsert('generated-withdrawn-source',sourceItem)).id;
 await f.node.sources.upsert('generated-withdrawn-source',{...sourceItem,revision:'2',text:'',deleted:true});
 assert.ok(f.node.store.evidence([restricted]).length,'withdrawal retains owner archive history while revoking model disclosure');
 for(const scope of [{anchorEvidenceIds:[]},{anchorEvidenceIds:[anchor.id,anchor.id]},{anchorEvidenceIds:Array.from({length:31},()=>randomUUID())},{anchorEvidenceIds:[anchor.id],evidenceIds:[anchor.id]}]){
  const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated invalid anchor request',...scope}});assert.equal(response.statusCode,400,response.body);
 }
 for(const scope of [{anchorEvidenceIds:[randomUUID()]},{anchorEvidenceIds:[anchor.id],deviceId:'generated-other'},{anchorEvidenceIds:[anchor.id],after:'2026-10-02T00:00:00Z'},{anchorEvidenceIds:[anchor.id],before:'2026-09-30T00:00:00Z'},{anchorEvidenceIds:[restricted]}]){
  const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated inaccessible anchor request',...scope}});assert.equal(response.statusCode,409,response.body);
 }
 assert.equal(calls,0,'knowing an original UUID never grants access or permits a model request');
 const valid=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated authorized reference',anchorEvidenceIds:[anchor.id]}});assert.equal(valid.statusCode,200,valid.body);assert.equal(calls,1);
});

test('deleting an anchor or cancelling its run fences a controlled late answer and its conversation publication',async t=>{
 for(const mode of ['delete','cancel'] as const)await t.test(mode,async sub=>{
  let entered!:()=>void,release!:()=>void,returned!:()=>void;const started=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;}),modelReturned=new Promise<void>(done=>{returned=done;});
  const f=await fixture(sub,async input=>{entered();await gate;returned();return {...answer(input),answer:'Generated late anchor answer',evidenceDependencies:{version:1,complete:true,ids:[]}};});sub.after(()=>release());const anchor=await add(f.node),id=randomUUID();
  const admitted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated controlled reference query',anchorEvidenceIds:[anchor.id]}}});assert.equal(admitted.statusCode,202,admitted.body);await started;
  const pinned=f.node.store.db.prepare('SELECT 1 FROM delegation_dependencies WHERE work_id=? AND evidence_id=?').get('query:'+id,anchor.id);assert.ok(pinned,'anchor revocation is registered before the waiting model returns');
  if(mode==='delete')assert.equal((await f.node.app.inject({method:'DELETE',url:'/api/notes/'+anchor.id,headers})).statusCode,200);else assert.equal((await f.node.app.inject({method:'POST',url:'/api/query-runs/'+id+'/cancel',headers,payload:{}})).statusCode,200);
  release();await modelReturned;await new Promise<void>(resolve=>setImmediate(resolve));const run=await completed(f.node,id);assert.notEqual(run.status,'completed',JSON.stringify(run));assert.equal(run.turnId,undefined,'a retired background run cannot publish a late conversation turn');
  const history=(await f.node.app.inject({url:'/api/conversations',headers})).json();for(const summary of history.items){const conversation=(await f.node.app.inject({url:'/api/conversations/'+summary.id,headers})).json();assert.ok(!JSON.stringify(conversation).includes('Generated late anchor answer'));}
  assert.notEqual(f.node.delegation.get('query:'+id).status,'succeeded');
 });
});


test('query preparation rolls back dependency pins when saving its prepared checkpoint fails',async t=>{
 let calls=0;const f=await fixture(t,async input=>{calls++;return answer(input);}),selected=await add(f.node),id=randomUUID();
 f.node.store.db.exec(`CREATE TEMP TRIGGER fixture_prepared_checkpoint_failure BEFORE INSERT ON delegation_payloads
   WHEN instr(NEW.json,'"prepared":')>0 BEGIN SELECT RAISE(ABORT,'Generated prepared checkpoint failure'); END;`);
 const accepted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated checkpoint rollback',evidenceIds:[selected.id]}}});assert.equal(accepted.statusCode,202,accepted.body);
 const failed=await completed(f.node,id);assert.equal(failed.status,'failed',JSON.stringify(failed));assert.equal(calls,0,'failed preparation must never reach the model');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM delegation_dependencies WHERE work_id=?').get('query:'+id)!.n,0,'dependency writes and prepared checkpoint share one transaction');
 const saved=f.node.delegation.journal.payload<{prepared?:unknown}>('query:'+id);assert.equal(saved.prepared,undefined);
 f.node.store.db.exec('DROP TRIGGER fixture_prepared_checkpoint_failure');
 const retry=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated valid subsequent preparation',evidenceIds:[selected.id]}});assert.equal(retry.statusCode,200,retry.body);assert.equal(calls,1);
});

test('narrowing device or time never sends a wider conversation or its summary to the model',async t=>{
 for(const narrow of [{deviceId:'generated-device-b'},{after:'2026-10-02T00:00:00Z'}])await t.test(JSON.stringify(narrow),async sub=>{
  const seen:QueryInput[]=[];let originals:string[]=[];
  const f=await fixture(sub,async input=>{
   seen.push(input);
   return {...answer(input),answer:seen.length===1?'GENERATED_PRIVATE_WIDE_ANSWER':'Generated narrow response',
    evidenceDependencies:{version:1,complete:true,ids:seen.length===1?originals:[]}};
  });
  const a=await add(f.node,'generated-device-a'),b=await add(f.node,'generated-device-b');originals=[a.id,b.id];
  const first=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'GENERATED_PRIVATE_WIDE_QUESTION'}});assert.equal(first.statusCode,200,first.body);
  const conversationId=first.json().conversationId,conversation=f.node.conversations.get(conversationId);
  const summary={text:'GENERATED_PRIVATE_WIDE_SUMMARY',coveredTurns:1,generatedAt:'2026-10-03T00:00:00Z',fingerprint:sha256(JSON.stringify(conversation.turns)),evidenceDependencies:{version:1,complete:true,ids:originals}};
  f.node.store.db.prepare('INSERT INTO working_memories(id,json) VALUES(?,?)').run(conversationId,JSON.stringify(summary));
  const follow=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated current owner input',conversationId,...narrow}});assert.equal(follow.statusCode,200,follow.body);
  assert.equal(seen.length,2);
  assert.doesNotMatch(JSON.stringify(seen[1].conversation),/GENERATED_PRIVATE_WIDE/,'a narrowed request must not send old questions, answers or summaries outside its range');
  assert.equal(seen[1].question,'Generated current owner input');
 });
});

test('a follow-up with the same bounded device and time keeps its compatible history',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{seen.push(input);return {...answer(input),answer:'Generated bounded response'};});
 const scope={deviceId:'generated-device-b',after:'2026-09-30T00:00:00Z',before:'2026-10-02T00:00:00Z'};
 const first=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated bounded question',...scope}});assert.equal(first.statusCode,200,first.body);
 const follow=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated bounded follow-up',conversationId:first.json().conversationId,...scope}});assert.equal(follow.statusCode,200,follow.body);
 assert.equal(seen.at(-1)!.conversation?.turns[0]?.answer,'Generated bounded response');
});

test('a previously narrowed turn cannot launder a wider prior answer into another bounded query',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{seen.push(input);return {...answer(input),answer:'GENERATED_WIDE_HISTORY_CONTENT'};});
 const a=await add(f.node,'generated-device-a');
 const first=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated unrestricted question'}});assert.equal(first.statusCode,200,first.body);
 const previous=f.node.conversations.get(first.json().conversationId);
 // An older version could save an apparently narrow turn after reading the
 // unrestricted turn. Preserve that actual lineage in the existing store.
 f.node.conversations.append(previous,{question:'Generated narrow question',deviceId:'generated-device-b'},{answer:'GENERATED_WIDE_HISTORY_CONTENT',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[a.id]}});
 const follow=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated current owner input',conversationId:previous.id,deviceId:'generated-device-b'}});assert.equal(follow.statusCode,200,follow.body);
 assert.doesNotMatch(JSON.stringify(seen.at(-1)!.conversation),/GENERATED_WIDE_HISTORY_CONTENT/);
});

test('newly attached images must also be inside the requested device and time scope',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{seen.push(input);return answer(input);});
 f.node.sources.register({id:'generated-scoped-attachment',name:'Generated attachment',kind:'upload',deviceId:'generated-device-a',platform:'import',retention:'archive'});
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#225588'}}).png().toBuffer();
 const upload=f.node.files.begin({sourceId:'generated-scoped-attachment',item:{externalId:'generated-image',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated image',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length},()=>{});
 f.node.files.part(upload.uploadId,0,bytes,()=>{});const attachment=(await f.node.files.commit(upload.uploadId,()=>{})).captureId;
 for(const scope of [{deviceId:'generated-device-b'},{after:'2026-10-02T00:00:00Z'}]){
  const denied=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated image question',attachmentIds:[attachment],...scope}});
  assert.equal(denied.statusCode,409,denied.body);
 }
 assert.equal(seen.length,0,'out-of-scope attachments must be rejected before the model');
 const allowed=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated image question',attachmentIds:[attachment],deviceId:'generated-device-a',after:'2026-09-30T00:00:00Z',before:'2026-10-02T00:00:00Z'}});
 assert.equal(allowed.statusCode,200,allowed.body);assert.deepEqual(seen[0].directImages?.map(image=>image.id),[attachment]);
});
