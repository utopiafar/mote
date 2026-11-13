import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {defaultLifecycleSettings} from '../src/memory-lifecycle.js';
import {sha256} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import {hostRun} from './fixtures/host-run.js';

const at='2026-11-13T08:00:00.000Z',text='Generated review file: the release still needs an owner decision.';
const token='generated-q2-context-owner',headers={authorization:'Bearer '+token};
const scope={kind:'selection' as const,sourceIds:['generated-q2-files']};
const scoped=new URLSearchParams({scope:JSON.stringify(scope)});
async function until(read:()=>boolean){
 const end=performance.now()+10000;
 while(!read()){assert.ok(performance.now()<end,'the generated queue must settle');await new Promise(resolve=>setTimeout(resolve,10));}
}

test('file deletion retires frozen work and privacy forget erases answers reached through compressed history',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date(at)});
 const dataDir=mkdtempSync(join(tmpdir(),'mote-q2-context-'));
 let node!:Awaited<ReturnType<typeof buildApp>>,oldTurn='',historyRead=false;
 let providerFailure:unknown;
 const result=(input:QueryInput,answer:string,extra:Partial<QueryResult>={}):QueryResult=>({answer,citations:[],trace:[],runId:hostRun(input),
  evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]},...extra});
 node=await buildApp({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelMaxTokens:512,modelBaseUrl:'https://generated.invalid',apiKey:'generated-only',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},
 {backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  try{
   if(input.skill==='working-memory')return result(input,'Generated summary: reverify the release owner in the original file.');
   if(input.taskContext?.materials){
    const context=input.taskContext as {originals:{id:string;offset:number;quote:string}[]};
    const proof=context.originals.find(value=>value.quote.includes(text));assert.ok(proof);
    return result(input,JSON.stringify({reason:'Generated file still needs an owner decision.',cards:[{action:'new',cardId:null,relatedCardIds:[],
     title:'Generated owner review',body:'Generated private file follow-up',reason:'The owner is undecided.',reminderReason:'An owner decision remains open.',
     evidence:[{id:proof.id,offset:proof.offset+proof.quote.indexOf(text),quote:text}],matterId:null}],commitments:[]}));
   }
   if(input.executionLane==='background'){
    const original=node.memories.readCurrentEvidence(input.evidenceIds??[]).find(record=>record.ocrText.includes(text));assert.ok(original);
    return result(input,JSON.stringify({state:'needs_owner_input',question:{
     prompt:'Generated private question: who owns this release?',reason:'The file does not name an owner.',choices:[],evidence:[{id:original.id,quote:text,offset:original.ocrText.indexOf(text)}]}}),
     {citations:[{id:original.id,capturedAt:at,appName:'Generated file',excerpt:text}]});
   }
   if(input.question==='Generated read the compressed original'){
    assert.match(input.conversation?.workingMemory?.text??'',/Generated summary/);
    const bridge=await startBridge(node.featureServices.archiveReader,input);
    try{
     const response=await fetch(bridge.url+'/conversation_history',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:oldTurn})});
     const page=await response.json() as any;assert.equal(response.status,200,JSON.stringify(page));
     assert.equal(page.data.items[0].id,oldTurn);assert.match(page.data.items[0].answer,/Generated original answer/);historyRead=true;
     return result(input,'Generated downstream after reading compressed history',{trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,
      sourceContextDependencies:bridge.sourceContextDependencies});
    }finally{await bridge.close();}
   }
   return result(input,'Generated original answer '+input.question+' '+'.'.repeat(700));
  }catch(error){providerFailure=error;throw error;}
 }}});
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 await node.app.ready();
 const call=async(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown)=>{
  const response=await node.app.inject({method,url,headers,payload});assert.ok(response.statusCode<300,method+' '+url+': '+response.body);return response.json();
 };
 const configuration=await call('GET','/api/configuration');
 await call('PUT','/api/configuration/conversations',{revision:configuration.revision,value:{context:{contextWindow:32000,contextWindowSource:'configured'}}});
 const nextConfiguration=await call('GET','/api/configuration');
 await call('PUT','/api/configuration/notifications',{revision:nextConfiguration.revision,value:{enabled:true,timeZone:'UTC',quietHours:null,minIntervalMinutes:60}});
 await call('POST','/api/sources',{id:scope.sourceIds[0],name:'Generated review files',kind:'local-files',deviceId:'generated-q2',platform:'macos',retention:'archive'});
 const bytes=Buffer.from(text),upload=await call('POST','/api/file-sync/v1/uploads',{sourceId:scope.sourceIds[0],relativePath:'review.txt',previousRevision:null,
  item:{externalId:'review.txt',revision:'1',observedAt:at,title:'Generated review.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)});
 const part=await node.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
 const file=await call('POST',`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,{});
 const processing=node.processing.view(),settings={...processing.settings,enabled:true,summarize:false};
 await node.processing.save({revision:processing.revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});await node.processing.tick();await node.materialOrganizer.tick(100);
 const chunk=node.files.chunks(file.id).find(value=>value.ocrText===text);assert.ok(chunk);
 const main=await call('GET','/api/conversations/main');
 const message=async(question:string)=>{
  const accepted=await call('POST','/api/conversations/messages',{conversationId:main.id,clientRequestId:randomUUID(),question,scope:{kind:'all'},anchorEvidenceIds:[file.id]});
  await until(()=>['completed','failed'].includes(node.conversations.message(accepted.id).status));
  if(providerFailure)throw providerFailure;
  assert.equal(node.conversations.message(accepted.id).status,'completed',JSON.stringify(node.conversations.message(accepted.id)));return accepted.id as string;
 };
 oldTurn=await message('Generated release context');await message('Generated review constraints');await message('Generated latest tail');
 const paged:string[]=[];let cursor:string|undefined;
 do{
  const page=await call('GET',`/api/conversations/${main.id}?`+new URLSearchParams({limit:'1',...(cursor?{cursor}:{})}));
  paged.push(...page.turns.map((turn:{id:string})=>turn.id));cursor=page.nextCursor??undefined;
 }while(cursor);
 assert.equal(paged.length,3);assert.equal(new Set(paged).size,3);assert.ok(paged.includes(oldTurn));
 await withFixtureOwnerModelWork(node,()=>node.working.compact(main.id,{...defaultLifecycleSettings,contextCharacters:4000,summaryCharacters:1000,recentTurns:1},input=>node.featureServices.queryAgent(input)));
 const summary=node.working.get(node.conversations.get(main.id));assert.ok(summary);assert.ok(summary.evidenceDependencies.ids.includes(file.id));
 const downstream=await message('Generated read the compressed original');assert.equal(historyRead,true);
 const saved=node.conversations.get(main.id).turns.find(turn=>turn.id===downstream)!;
 assert.ok(saved.result?.evidenceDependencies?.ids.includes(file.id),'the real history tool must carry the original file dependency');
 const followup=node.featureServices.assistantFollowup,material=node.materials.list({limit:100}).items.find(value=>value.origin.externalId==='review.txt');assert.ok(material);
 const analysis=await followup.start({operationId:'generated-q2-followup',requestId:randomUUID(),scope,materialRefs:[material.ref],mode:{kind:'change'}},
  {identities:[],connections:node.featureServices.availableModelConnections()});
 const batchId=followup.progress(analysis.id).batch!.task.id;
 await until(()=>node.batchProcessing.progress(batchId).task.state==='succeeded');if(providerFailure)throw providerFailure;
 const published=await followup.finish(analysis.id);assert.equal(published.cardIds.length,1);
 assert.deepEqual((await call('GET','/api/assistant-notifications?'+scoped)).items.map((item:{id:string})=>item.id),published.cardIds);
 const card=node.featureServices.assistantCards.get(published.cardIds[0],scope);
 const command={requestId:randomUUID(),cardId:card.id,expectedRevision:card.revision,goal:'Generated decide the release owner',scope};
 const started=await call('POST','/api/assistant/tasks',command),repeated=await call('POST','/api/assistant/tasks',command);assert.equal(started.taskId,repeated.taskId);
 await until(()=>Boolean(node.store.db.prepare("SELECT 1 FROM owner_questions WHERE json_extract(json,'$.state')='open'").get())||Boolean(providerFailure)||['failed','stale'].includes(String(node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(started.taskId)?.state)));
 if(providerFailure)throw providerFailure;
 const operationId=String(node.store.db.prepare('SELECT operation_id FROM task_records WHERE id=?').get(started.taskId)!.operation_id);
 const question=(await call('GET','/api/owner-questions?'+new URLSearchParams({operationId}))).items[0];assert.ok(question,JSON.stringify(node.executor.list({operationId}).items));
 assert.equal((await call('GET',`/api/assistant/tasks/${started.taskId}?${scoped}`)).task.state,'needs_input');
 await call('DELETE','/api/captures/'+file.id);
 const retained=await call('GET',`/api/conversations/${main.id}?limit=10`);
 assert.equal(retained.turns.length,4);
 assert.ok(retained.turns.every((turn:{evidenceUnavailable?:boolean})=>turn.evidenceUnavailable),'ordinary deletion retains submitted dialogue with unavailable originals');
 assert.match(JSON.stringify(retained),/Generated downstream after reading compressed history/);
 assert.equal(node.working.get(node.conversations.get(main.id)),undefined);
 assert.deepEqual((await call('GET','/api/assistant-cards?'+scoped)).items,[]);
 assert.deepEqual((await call('GET','/api/assistant-notifications?'+scoped)).items,[]);
 // The existing privacy-forget endpoint must also erase generations that
 // retained dialogue after the ordinary original was already removed.
 await call('DELETE','/api/files/'+file.id);
 const history=await call('GET',`/api/conversations/${main.id}?limit=10`);
 assert.equal(history.turns.length,4,'deletion invalidates dependent answers while retaining the original dialogue');
 assert.ok(history.turns.every((turn:{evidenceDeleted?:boolean})=>turn.evidenceDeleted));
 assert.doesNotMatch(JSON.stringify(history),/Generated original answer|Generated downstream after reading|Generated summary/);
 assert.equal(node.working.get(node.conversations.get(main.id)),undefined);
 assert.deepEqual((await call('GET','/api/assistant-cards?'+scoped)).items,[]);
 assert.deepEqual((await call('GET','/api/assistant-notifications?'+scoped)).items,[]);
 const currentQuestion=await call('GET','/api/owner-questions/'+question.id);assert.equal(currentQuestion.state,'obsolete');assert.doesNotMatch(JSON.stringify(currentQuestion),/Generated private question/);
 const retired=node.store.db.prepare('SELECT id,state,input_json,result_json FROM task_records WHERE operation_id IN (?,?)').all(analysis.operationId,operationId);
 assert.ok(retired.length>=6,'both product snapshots and every batch/item copy must be checked');
 for(const task of retired){
  assert.equal(task.state,'stale');assert.equal(task.input_json,null);assert.equal(task.result_json,null);
 }
 const late=await node.app.inject({method:'POST',url:'/api/owner-questions/'+question.id+'/reply',headers,payload:{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',answer:'Generated late owner'}});
 assert.equal(late.statusCode,409);await assert.rejects(followup.finish(analysis.id),{statusCode:409});
});
