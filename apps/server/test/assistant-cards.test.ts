import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EvidenceDependencies,QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {TaskRecords} from '../src/task-records.js';
import {AssistantCards,type AssistantCardPublication} from '../src/assistant-cards.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {SourceStore} from '../src/sources.js';
import {Store,StoreError} from '../src/store.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const all:QueryScope={kind:'all'};
const dependencies=(ids:string[]=[]):EvidenceDependencies=>({version:1,complete:true,ids});
const conflict=(error:unknown)=>Boolean(error&&typeof error==='object'&&'statusCode' in error&&error.statusCode===409);

test('assistant cards retain scoped versions and feedback, resolve safely, and retire deleted evidence',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-cards-'));
 const config:Config={dataDir:directory,token:'generated-card-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token},cards=node.featureServices.assistantCards;
 const publish=(input:AssistantCardPublication,expectedRevision:number|undefined,scope:QueryScope)=>cards.publish(input,expectedRevision,scope,ids=>{if(ids.some(id=>!node.featureServices.evidenceReader.memories.isCurrentEvidence(id)))throw new StoreError('Generated evidence is no longer current',409);});
 const capture=async(text:string,deviceId='generated-device')=>{const id=randomUUID();await node.store.ingest({id,deviceId,deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:text});return id;};
 const originalA=await capture('GENERATED_SECRET_A','device-a'),originalB=await capture('GENERATED_PUBLIC_B','device-b');
 let mixedTaskCardId='',mixedTaskRevision=0;
 const item=(id:string,version:string,ids:string[],body:string,state:'open'|'resolved'='open')=>({id,kind:'suggestion' as const,matterId:null,version,state,title:'Generated title '+body,body,evidence:ids.map(id=>({id,quote:id===originalA?'GENERATED_SECRET_A':'GENERATED_PUBLIC_B'})),evidenceDependencies:dependencies(ids)});

 await t.test('same explicit object and version is one card, conflicting writers do not overwrite correction or read state',()=>{
  const id=randomUUID(),question=(version:string,ids:string[],body:string,state:'open'|'resolved'='open')=>({...item(id,version,ids,body,state),kind:'question' as const}),initial=question('v1',[originalA],'first');
  const created=publish(initial,undefined,all),replayed=publish(structuredClone(initial),undefined,all);
  assert.equal(created.id,replayed.id);assert.equal(created.revision,1);
  assert.throws(()=>publish({...initial,body:'conflicting'},undefined,all),conflict);
  let current=cards.feedback(id,{expectedRevision:created.revision,action:'read'},all);assert.ok(current.readAt);
  current=cards.feedback(id,{expectedRevision:current.revision,action:'correct',note:'Generated owner correction'},all);
  assert.throws(()=>publish(question('old-result',[originalA],'old'),created.revision,all),conflict);
  const observedRevision=current.revision;
  const updated=publish(question('v2',[originalA,originalB],'updated'),observedRevision,all);
  assert.throws(()=>publish(question('v3',[originalA],'other writer'),observedRevision,all),conflict);
  assert.equal(updated.readAt,current.readAt,'content updates do not create a second unread fact');
  const resolved=publish(question('v3',[originalB],'resolved','resolved'),updated.revision,all);
  assert.equal(resolved.state,'resolved');
  assert.deepEqual(cards.history(id,{scope:all}).items.map(v=>v.version),['v3','v2','v1']);
  const firstHistory=cards.history(id,{scope:all,limit:1});assert.equal(firstHistory.items[0].version,'v3');
  publish(question('v4',[originalB],'resolved follow-up','resolved'),resolved.revision,all);
  const rest=cards.history(id,{scope:all,limit:2,cursor:firstHistory.nextCursor!});assert.deepEqual(rest.items.map(value=>value.version),['v2','v1']);
  const forgedHistory=JSON.parse(Buffer.from(firstHistory.nextCursor!,'base64url').toString());forgedHistory.version='v1';
  assert.throws(()=>cards.history(id,{scope:all,cursor:Buffer.from(JSON.stringify(forgedHistory)).toString('base64url')}),/Invalid assistant card history cursor/);
  const narrow=cards.history(id,{scope:{kind:'selection',evidenceIds:[originalB]}});assert.deepEqual(narrow.items.map(value=>value.version),['v4','v3']);
  assert.doesNotMatch(JSON.stringify(narrow),/GENERATED_SECRET_A|Generated owner correction/);
  assert.equal(cards.get(id,all).feedback[0].note,'Generated owner correction');
  const feed=cards.page({scope:all,limit:100});assert.equal(feed.items.filter(card=>card.id===id).length,1);
 });

 await t.test('later, ignore and no-reminder feedback preserve evidence, and acceptance only links an existing task',()=>{
  const id=randomUUID();let card=publish(item(id,'one',[originalB],'independent'),undefined,all);
  card=cards.feedback(id,{expectedRevision:card.revision,action:'later',until:'2026-12-01T00:00:00Z'},all);
  card=cards.feedback(id,{expectedRevision:card.revision,action:'ignore',note:'Generated owner reason'},all);
  card=cards.feedback(id,{expectedRevision:card.revision,action:'never_remind'},all);
  assert.equal(card.evidence[0].id,originalB);assert.equal(card.evidence[0].quote,'GENERATED_PUBLIC_B');
  assert.deepEqual(card.feedback.map(entry=>entry.action),['later','ignore','never_remind']);
  const tasks=new TaskRecords(node.store),task=tasks.create({operationId:randomUUID(),kind:'generated',requestId:randomUUID(),input:{goal:'Generated'},evidenceDependencies:dependencies([originalB])},ids=>{assert.deepEqual(ids,[originalB]);});
  const linked=cards.associateTask(id,card.revision,task.id,all);assert.equal(linked.acceptedTaskId,task.id);
  assert.equal(tasks.page().items.length,1,'linking did not create another task');
  assert.throws(()=>cards.associateTask(id,card.revision,randomUUID(),all),conflict);
 });

 await t.test('accepted task links do not disclose a task outside the selected scope',()=>{
  mixedTaskCardId=randomUUID();const card=publish(item(mixedTaskCardId,'one',[originalB],'Generated independently scoped card'),undefined,all);
  const tasks=new TaskRecords(node.store),task=tasks.create({operationId:randomUUID(),kind:'generated',requestId:randomUUID(),input:{goal:'Generated mixed task'},evidenceDependencies:dependencies([originalA,originalB])},()=>{});
  const linked=cards.associateTask(mixedTaskCardId,card.revision,task.id,all);mixedTaskRevision=linked.revision;assert.equal(linked.acceptedTaskId,task.id);
  assert.equal(cards.get(mixedTaskCardId,{kind:'selection',evidenceIds:[originalB]}).acceptedTaskId,null);
 });

 await t.test('feed pages are stable across new cards and edits, and restricted scopes hide mixed bodies and counts',()=>{
  const ids=Array.from({length:4},()=>randomUUID());
  for(const id of ids)publish(item(id,'one',[originalB],'PAGE_'+id),undefined,all);
  const scope:QueryScope={kind:'selection',evidenceIds:[originalB]};
  const first=cards.page({scope,limit:2});assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const firstIds=first.items.map(card=>card.id),changed=first.items[0];cards.feedback(changed.id,{expectedRevision:changed.revision,action:'read'},scope);
  const newer=randomUUID();publish(item(newer,'one',[originalB],'PAGE_NEW'),undefined,all);
  const seen=[...firstIds];let cursor=first.nextCursor;
  while(cursor){const page=cards.page({scope,limit:2,cursor});seen.push(...page.items.map(card=>card.id));cursor=page.nextCursor;}
  assert.equal(new Set(seen).size,seen.length);assert.ok(ids.every(id=>seen.includes(id)));assert.ok(!seen.includes(newer));
  const restricted=cards.page({scope,limit:100});assert.doesNotMatch(JSON.stringify(restricted),/GENERATED_SECRET_A|Generated owner correction/);
  assert.deepEqual(cards.page({scope:{kind:'selection',evidenceIds:[]}}),{items:[],nextCursor:null});
  assert.throws(()=>cards.page({scope:all,cursor:first.nextCursor!}));
  const device=cards.page({scope:{kind:'all',deviceId:'device-b'},limit:100});assert.doesNotMatch(JSON.stringify(device),/GENERATED_SECRET_A/);
 });

 await t.test('a valid cursor survives deletion of its anchor but cannot be forged to probe a hidden card',async()=>{
  const older=await capture('Generated page older'),newer=await capture('Generated page newer');
  const oldId=randomUUID(),newId=randomUUID();
  publish({...item(oldId,'one',[older],'older page'),evidence:[{id:older,quote:'Generated page older'}]},undefined,all);
  publish({...item(newId,'one',[newer],'newer page'),evidence:[{id:newer,quote:'Generated page newer'}]},undefined,all);
  const first=cards.page({scope:all,limit:1});assert.equal(first.items[0].id,newId);assert.ok(first.nextCursor);
  const forged=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());forged.id=oldId;
  assert.throws(()=>cards.page({scope:all,cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')}),/Invalid assistant card cursor/);
  node.store.delete(newer);
  const second=cards.page({scope:all,limit:1,cursor:first.nextCursor!});assert.equal(second.items[0].id,oldId);
 });

 await t.test('all five kinds support an absent matter without inventing an evidence dependency',()=>{
  for(const kind of ['activity','suggestion','briefing','artifact','question'] as const){
   const id=randomUUID(),saved=publish({...item(id,'one',[],'Generated '+kind),kind},undefined,all);
   assert.equal(saved.matterId,null);assert.equal(saved.kind,kind);assert.deepEqual(saved.evidenceDependencies.ids,[]);
  }
 });

 await t.test('a failed deletion rolls back the original and all card cleanup',async()=>{
  const original=await capture('Generated rollback original'),id=randomUUID(),input={...item(id,'rollback',[original],'Generated rollback body'),evidence:[{id:original,quote:'Generated rollback original'}]};
  let saved=publish(input,undefined,all);saved=cards.feedback(id,{expectedRevision:saved.revision,action:'correct',note:'Generated rollback feedback'},all);
  node.store.db.exec("CREATE TEMP TRIGGER generated_card_cleanup_failure BEFORE DELETE ON assistant_card_feedback BEGIN SELECT RAISE(ABORT,'generated card cleanup failure'); END");
  assert.throws(()=>node.store.delete(original),/generated card cleanup failure/);
  assert.equal(node.store.evidence([original]).length,1);assert.deepEqual(cards.get(id,all),saved);
  node.store.db.exec('DROP TRIGGER generated_card_cleanup_failure');node.store.delete(original);
  assert.throws(()=>cards.get(id,all),{statusCode:404});
 });

 await t.test('source revision marks a card stale while preserving authorized historical versions',async()=>{
  const sourceId='generated-card-source';
  node.sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-source-device',platform:'import'});
  const source={externalId:'document',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message' as const,layer:'original' as const,text:'Generated first source version'};
  const first=await node.sources.upsert(sourceId,source),id=randomUUID();
  const firstCard={...item(id,'source-1',[first.id],'Generated first conclusion'),evidence:[{id:first.id,quote:source.text}]};
  const original=publish(firstCard,undefined,all);
  const otherId=randomUUID(),historical=publish({...firstCard,id:otherId},undefined,all);
  const later=publish(item(otherId,'independent',[originalB],'current independent'),historical.revision,all);
  const laterFeedback=cards.feedback(otherId,{expectedRevision:later.revision,action:'correct',note:'Generated correction after reading history'},all);
  const second=await node.sources.upsert(sourceId,{...source,revision:'2',observedAt:'2026-10-02T00:00:00Z',text:'Generated second source version'});
  const stillCurrent=cards.get(otherId,all);assert.equal(stillCurrent.state,'open');assert.equal(stillCurrent.revision,laterFeedback.revision+1);
  assert.equal(stillCurrent.feedback[0].evidenceStale,true);
  assert.deepEqual(cards.get(otherId,{kind:'selection',evidenceIds:[originalB]}).feedback,[],'feedback influenced by hidden history is not disclosed');
  assert.throws(()=>cards.feedback(otherId,{expectedRevision:laterFeedback.revision,action:'read'},all),conflict);
  const stale=cards.get(id,all);assert.equal(stale.state,'stale');assert.equal(stale.revision,original.revision+1);assert.equal(stale.evidenceStale,true);
  assert.ok(!cards.page({scope:all,limit:100}).items.some(card=>card.id===id));
  assert.throws(()=>publish({...firstCard,version:'late'},original.revision,all),conflict);
  const replacement=publish({...item(id,'source-2',[second.id],'Generated updated conclusion'),evidence:[{id:second.id,quote:'Generated second source version'}]},stale.revision,all);
  assert.equal(replacement.state,'open');
  const history=cards.history(id,{scope:all}).items;assert.deepEqual(history.map(entry=>entry.version),['source-2','source-1']);assert.equal(history[1].evidenceStale,true);
  assert.deepEqual(cards.history(id,{scope:{kind:'selection',evidenceIds:[second.id]}}).items.map(entry=>entry.version),['source-2']);
  assert.deepEqual(cards.page({scope:{kind:'selection',sourceIds:[]}}),{items:[],nextCursor:null});
  const restricted=cards.page({scope:{kind:'selection',sourceIds:[sourceId]},limit:100});assert.ok(restricted.items.some(card=>card.id===id));
 });

 await t.test('source metadata lineage is scoped, becomes stale on correction, and is purged when the source is removed',async()=>{
  const sourceId='generated-card-context';node.sources.register({id:sourceId,name:'Generated source name',kind:'custom',deviceId:'generated-device',platform:'import'});
  const pin=node.sources.contexts.metadataIdentity(sourceId),id=randomUUID();
  const original=await node.sources.upsert(sourceId,{externalId:'generated-document',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated referenced source'});
  const attachedId=randomUUID(),attached=publish({...item(attachedId,'attached',[original.id],'Generated attached card'),evidence:[{id:original.id,quote:'Generated referenced source'}],sourceContextDependencies:[pin]},undefined,all);
  node.store.delete(original.id);assert.throws(()=>cards.get(attached.id,all),{statusCode:404});
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM assistant_card_context WHERE card_id=?').get(attachedId)!.n,0,'deleting evidence also removes the retired version source references');
  const first={...item(id,'context-1',[],'GENERATED_SOURCE_CONTEXT'),sourceContextDependencies:[pin]};
  assert.throws(()=>publish(first,undefined,{kind:'selection',sourceIds:['different-source']}),conflict);
  const card=publish(first,undefined,all);
  assert.equal(cards.get(id,{kind:'selection',sourceIds:[sourceId]}).body,'GENERATED_SOURCE_CONTEXT');
  assert.throws(()=>cards.get(id,{kind:'selection',evidenceIds:[originalB]}),{statusCode:404});
  assert.doesNotMatch(JSON.stringify(cards.page({scope:{kind:'selection',sourceIds:['different-source']}})),/GENERATED_SOURCE_CONTEXT/);
  node.sources.update(sourceId,{name:'Generated renamed source'});
  const stale=cards.get(id,all);assert.equal(stale.state,'stale');assert.equal(stale.revision,card.revision+1);assert.equal(stale.evidenceStale,true);
  assert.ok(!cards.page({scope:all,limit:100}).items.some(value=>value.id===id));
  const pin2=node.sources.contexts.metadataIdentity(sourceId);
  const current=publish({...first,version:'context-2',body:'Generated updated metadata',sourceContextDependencies:[pin2]},stale.revision,all);
  cards.feedback(id,{expectedRevision:current.revision,action:'correct',note:'Generated context-based feedback'},all);
  assert.equal(cards.history(id,{scope:all}).items[1].evidenceStale,true);
  node.sources.updateContext(sourceId,{expectedVersion:0,description:'Generated owner description'});
  assert.equal(cards.get(id,all).state,'stale');
  const descriptionPin=node.sources.contexts.identity(sourceId)!;
  const contextCard=publish({...first,id:randomUUID(),version:'description',sourceContextDependencies:[descriptionPin]},undefined,all);
  node.sources.updateContext(sourceId,{expectedVersion:1,description:'Generated corrected description'});
  assert.equal(cards.get(contextCard.id,all).state,'stale');
  node.store.db.prepare('DELETE FROM source_connections WHERE id=?').run(sourceId);
  assert.throws(()=>cards.get(id,all),{statusCode:404});
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM assistant_card_versions WHERE card_id=? AND private_json IS NOT NULL').get(id)!.n,0);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM assistant_card_feedback WHERE card_id=?').get(id)!.n,0);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM assistant_card_context WHERE card_id=?').get(id)!.n,0);
 });

 await t.test('an owner Memory correction invalidates a dependent card without a new source file',async()=>{
  const raw=await capture('Generated Memory original'),memories=node.featureServices.evidenceReader.memories;
  const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated memory',statement:'Generated Memory original ['+raw+']',uncertainty:'Generated uncertainty',evidenceIds:[raw]}]}),citations:[{id:raw,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:'Generated Memory original'}],trace:[],runId:randomUUID()});
  const proposed=memories.extract(result,'generated').items[0],memory=memories.publish(proposed.id,proposed.version);
  const id=randomUUID(),input={...item(id,'memory-1',[],'Generated prior Memory conclusion'),evidenceDependencies:dependencies([memory.id])};
  const card=cards.publish(input,undefined,all,()=>{});
  await memories.correct(memory.id,{version:memory.version,title:'Generated correction',statement:'Generated corrected fact',uncertainty:''});
  const stale=cards.get(id,all);assert.equal(stale.state,'stale');assert.equal(stale.revision,card.revision+1);assert.equal(stale.evidenceStale,true);
  assert.throws(()=>cards.feedback(id,{expectedRevision:card.revision,action:'read'},all),conflict);
  memories.delete(memory.id);assert.throws(()=>cards.get(id,all),{statusCode:404});
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM assistant_card_versions WHERE card_id=? AND private_json IS NOT NULL').get(id)!.n,0);
 });

 await t.test('a cancelled task cannot publish a late card while its original is still readable',()=>{
  const tasks=new TaskRecords(node.store),task=tasks.create({operationId:randomUUID(),kind:'generated',requestId:randomUUID(),input:{goal:'Generated'},evidenceDependencies:dependencies([originalB])},()=>{});
  tasks.setState(task.id,task.revision,'cancelled');const id=randomUUID(),input=item(id,'late',[originalB],'Late result');
  assert.throws(()=>cards.publish(input,undefined,all,()=>{tasks.evidenceDependencies(task.id,task.revision,()=>{});}),conflict);
  assert.throws(()=>cards.get(id,all),{statusCode:404});
  assert.throws(()=>cards.publish(input,undefined,all,async()=>{}),conflict);
 });

 await t.test('real deletion clears private versions, references and dependent feedback without erasing independent history',async()=>{
  const id=randomUUID(),initial=publish(item(id,'a',[originalA],'GENERATED_SECRET_A'),undefined,all);
  const commented=cards.feedback(id,{expectedRevision:initial.revision,action:'correct',note:'GENERATED_SECRET_A feedback'},all);
  const independent=publish(item(id,'b',[originalB],'GENERATED_PUBLIC_B'),commented.revision,all);
  const latest=cards.feedback(id,{expectedRevision:independent.revision,action:'ignore',note:'GENERATED_PUBLIC_B feedback'},all);
  const independentId=randomUUID(),independentCard=publish(item(independentId,'b',[originalB],'independent B'),undefined,all);
  cards.feedback(independentId,{expectedRevision:independentCard.revision,action:'ignore',note:'Independent B feedback'},all);
  const response=await node.app.inject({method:'DELETE',url:'/api/captures/'+originalA,headers});assert.equal(response.statusCode,200,response.body);
  const retained=cards.get(mixedTaskCardId,all);assert.equal(retained.acceptedTaskId,null);assert.equal(retained.revision,mixedTaskRevision+1);
  const current=cards.get(id,all);assert.equal(current.revision,latest.revision+1);assert.equal(current.body,'GENERATED_PUBLIC_B');
  assert.throws(()=>cards.feedback(id,{expectedRevision:latest.revision,action:'read'},all),conflict);
  assert.deepEqual(current.feedback,[],'feedback may depend on an earlier version the owner saw');
  assert.equal(cards.get(independentId,all).feedback[0].note,'Independent B feedback');
  assert.deepEqual(cards.history(id,{scope:all}).items.map(v=>v.version),['b']);
  const versions=node.store.db.prepare('SELECT version,private_json FROM assistant_card_versions WHERE card_id=? ORDER BY seq').all(id);
  assert.equal(versions[0].private_json,null);assert.ok(versions[1].private_json);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM assistant_card_evidence WHERE evidence_id=?').get(originalA)!.n,0);
  const dump=JSON.stringify({current,history:cards.history(id,{scope:all}),versions,feedback:node.store.db.prepare('SELECT * FROM assistant_card_feedback WHERE card_id=?').all(id)});
  assert.doesNotMatch(dump,/GENERATED_SECRET_A/);
  assert.throws(()=>publish(item(id,'a',[originalA],'GENERATED_SECRET_A'),undefined,all),conflict);
 });

 await t.test('owner HTTP feed uses the same read state and rejects other credentials',async()=>{
  const id=randomUUID(),card=publish(item(id,'http',[originalB],'HTTP_BODY'),undefined,all);
  const allQuery=new URLSearchParams({scope:JSON.stringify(all),limit:'100'}),feedbackQuery=new URLSearchParams({scope:JSON.stringify(all)});
  const before=await node.app.inject({url:'/api/assistant-cards?'+allQuery,headers});assert.equal(before.statusCode,200,before.body);
  assert.equal(before.json().items.find((value:{id:string})=>value.id===id).readAt,null);
  const read=await node.app.inject({method:'POST',url:`/api/assistant-cards/${id}/feedback?${feedbackQuery}`,headers,payload:{expectedRevision:card.revision,action:'read'}});assert.equal(read.statusCode,200,read.body);
  const after=await node.app.inject({url:'/api/assistant-cards?'+allQuery,headers});assert.equal(after.json().items.find((value:{id:string})=>value.id===id).readAt,read.json().readAt);
  assert.equal(cards.get(id,all).readAt,read.json().readAt,'the domain and feed share one read fact');
  assert.equal((await node.app.inject({url:'/api/assistant-cards'})).statusCode,401);
  assert.equal((await node.app.inject({url:'/api/assistant-cards',headers})).statusCode,400,'scope must be explicit');
  const {invitation}=node.connections.invite({serverUrl:'https://fixture.invalid',label:'Generated collector'},'collector');
  const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated',platform:'android'});
  assert.equal((await node.app.inject({url:'/api/assistant-cards',headers:{authorization:'Bearer '+collector.token}})).statusCode,403);
  const narrow=await node.app.inject({url:'/api/assistant-cards?'+new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[]})}),headers});assert.equal(narrow.statusCode,200,narrow.body);assert.deepEqual(narrow.json(),{items:[],nextCursor:null});
  const hiddenOriginal=await capture('Generated hidden feedback original','generated-hidden-device'),hiddenId=randomUUID();
  publish({...item(hiddenId,'one',[hiddenOriginal],'Generated hidden card'),evidence:[{id:hiddenOriginal,quote:'Generated hidden feedback original'}]},undefined,all);
  const narrowQuery=new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[originalB]})});
  for(const candidate of [hiddenId,randomUUID()]){
   const denied=await node.app.inject({method:'POST',url:`/api/assistant-cards/${candidate}/feedback?${narrowQuery}`,headers,payload:{expectedRevision:999,action:'read'}});
   assert.equal(denied.statusCode,404,'a revision conflict cannot reveal a hidden card');
  }
 });
});

test('encrypted card bodies and feedback survive restart and maintenance deletion purges them',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-card-restart-'));
 const config:Config={dataDir:directory,token:'generated-card-restart-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',dataKey:'ab'.repeat(32),contentEncryptionEnabled:true};
 const options={backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}};
 let node=await buildApp(config,options);let closed=false;
 t.after(async()=>{if(!closed)await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const original=randomUUID(),id=randomUUID();await node.store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated encrypted original'});
 const input={id,kind:'briefing' as const,matterId:null,version:'encrypted',state:'open' as const,title:'Generated private title',body:'Generated private body',evidence:[{id:original,quote:'Generated encrypted original'}],evidenceDependencies:dependencies([original])};
 let card=node.featureServices.assistantCards.publish(input,undefined,all,()=>{});
 card=node.featureServices.assistantCards.feedback(id,{expectedRevision:card.revision,action:'correct',note:'Generated private feedback'},all);
 const privateRows=JSON.stringify({version:node.store.db.prepare('SELECT private_json FROM assistant_card_versions WHERE card_id=?').get(id),feedback:node.store.db.prepare('SELECT private_json FROM assistant_card_feedback WHERE card_id=?').get(id)});
 assert.match(privateRows,/aes:/);assert.doesNotMatch(privateRows,/Generated private/);
 await node.app.close();closed=true;node=await buildApp(config,options);closed=false;
 assert.equal(node.featureServices.assistantCards.get(id,all).body,'Generated private body');assert.equal(node.featureServices.assistantCards.get(id,all).feedback[0].note,'Generated private feedback');
 await node.app.close();closed=true;
 const maintenance=new (await import('../src/store.js')).Store(directory,{dataKey:config.dataKey,contentEncryptionEnabled:true,maintenance:true});
 try{
  maintenance.delete(original);
  assert.equal(maintenance.db.prepare('SELECT private_json FROM assistant_card_versions WHERE card_id=?').get(id)!.private_json,null);
  assert.equal(maintenance.db.prepare('SELECT count(*) n FROM assistant_card_feedback WHERE card_id=?').get(id)!.n,0);
  assert.equal(maintenance.db.prepare('SELECT count(*) n FROM assistant_card_evidence WHERE card_id=?').get(id)!.n,0);
 }finally{maintenance.close();}
});

test('vault quota failure rolls back a card and its evidence inside the caller transaction',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-card-quota-'));let store=new Store(directory);
 const reader=new EvidenceReader(store,new SourceStore(store));void reader;
 const budget=store.logicalBytes()+1000;store.close();store=new Store(directory,{maxStorageBytes:budget});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const cards=new AssistantCards(store,new EvidenceReader(store,new SourceStore(store))),id=randomUUID();
 const input={id,kind:'artifact' as const,matterId:null,version:'quota',state:'open' as const,title:'Generated quota',body:'Generated content '.repeat(300),evidence:[],evidenceDependencies:dependencies()};
 store.db.exec('BEGIN IMMEDIATE');
 assert.throws(()=>cards.publish(input,undefined,all,()=>{}),{statusCode:507});assert.equal(store.db.isTransaction,true);
 store.db.exec('COMMIT');
 assert.equal(store.db.prepare('SELECT count(*) n FROM assistant_cards WHERE id=?').get(id)!.n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM assistant_card_versions WHERE card_id=?').get(id)!.n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM assistant_card_evidence WHERE card_id=?').get(id)!.n,0);
});
