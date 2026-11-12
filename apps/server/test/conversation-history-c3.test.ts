import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';

const token='generated-c3-owner',headers={authorization:'Bearer '+token};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const answer=(text:string,ids:string[]=[])=>({answer:text,citations:ids.map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:'Generated excerpt'})),trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}});
const longAnswer='GENERATED_VISIBLE answer '+'.'.repeat(3999-'GENERATED_VISIBLE answer '.length)+'😀'+'.'.repeat(1002);

test('HTTP pages remain stable across new and deleted turns and locate an earlier turn',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-c3-pages-')),node=await buildApp(config(dir),{backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const id=node.conversations.main().id,turns=[];
  for(let i=0;i<7;i++)turns.push(node.conversations.receive({conversationId:id,question:`Generated ${i}`}));
  const page=async(query:string)=>{const res=await node.app.inject({url:`/api/conversations/${id}?${query}`,headers});assert.equal(res.statusCode,200,res.body);return res.json();};
  const first=await page('limit=2');assert.deepEqual(first.turns.map((v:any)=>v.seq),[5,6]);assert.equal(first.nextCursor,'5');
  node.conversations.receive({conversationId:id,question:'Generated newly inserted'});
  node.store.db.prepare('DELETE FROM conversation_turns WHERE id=?').run(turns[1].id);
  const second=await page(`limit=2&cursor=${first.nextCursor}`);assert.deepEqual(second.turns.map((v:any)=>v.seq),[3,4]);
  const third=await page(`limit=2&cursor=${second.nextCursor}`);assert.deepEqual(third.turns.map((v:any)=>v.seq),[0,2]);assert.equal(third.nextCursor,null);
  const located=await page(`limit=2&anchor=${turns[2].id}`);assert.equal(located.turns.at(-1).id,turns[2].id);
  assert.equal((await node.app.inject({url:`/api/conversations/${id}?anchor=${turns[1].id}`,headers})).statusCode,404);
  node.store.db.prepare('DELETE FROM conversation_turns WHERE conversation_id=? AND idx=7').run(id);
  assert.equal(node.conversations.receive({conversationId:id,question:'Generated after newest deletion'}).seq,8,'a deleted maximum sequence is never reused');
  assert.equal((await node.app.inject({url:`/api/conversations/${id}?cursor=9007199254740992`,headers})).statusCode,400);
});

test('a scoped model history cursor continues after the same private profile restarts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-c3-cursor-restart-')),after='2026-09-01T00:00:00Z';
  let node!:Awaited<ReturnType<typeof buildApp>>,cursor='',firstId='',resumed=false,failure:unknown;
  const agent={configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    const {startBridge}=await import('../../../packages/agent/dist/bridge.js'),bridge=await startBridge(node.featureServices.archiveReader,input);
    try{
      const response=await fetch(bridge.url+'/conversation_search',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({query:'GENERATED_CURSOR_SEED',limit:1,...(cursor?{cursor}:{})})});
      const page=await response.json() as any;assert.equal(response.status,200,JSON.stringify(page));assert.equal(page.data.items.length,1);
      if(!cursor){firstId=page.data.items[0].id;cursor=page.data.nextCursor;assert.ok(cursor);}
      else{assert.notEqual(page.data.items[0].id,firstId);assert.equal(page.data.nextCursor,null);resumed=true;}
      return {...answer('Generated cursor result'),trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
    }catch(error){failure=error;throw error;}finally{await bridge.close();}
  }};
  node=await buildApp(config(dir),{backgroundWorker:false,agent});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const id=node.conversations.main().id;
  for(let i=0;i<2;i++)node.conversations.append(node.conversations.get(id),{question:'GENERATED_CURSOR_SEED '+i,after},answer('Generated saved answer'));
  const query=()=>node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:id,question:'Generated cursor query',after}});
  const first=await query();if(failure)throw failure;assert.equal(first.statusCode,200,first.body);
  await node.app.close();node=await buildApp(config(dir),{backgroundWorker:false,agent});
  const second=await query();if(failure)throw failure;assert.equal(second.statusCode,200,second.body);assert.equal(resumed,true);
});

test('a synchronous query cannot read a later turn with the same millisecond timestamp',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-c3-boundary-')),after='2026-09-01T00:00:00Z';
  let node!:Awaited<ReturnType<typeof buildApp>>,conversationId='',failure:unknown;
  node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    const runId=input.traceContext!.operationId!.slice('query:'.length);
    const run=node.store.db.prepare("SELECT json_extract(json,'$.createdAt') createdAt FROM query_runs WHERE id=?").get(runId)!;
    const later=node.conversations.append(node.conversations.get(conversationId),{question:'GENERATED_FUTURE_TURN',after},answer('Generated later answer'));
    node.store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.createdAt',?) WHERE id=?").run(run.createdAt,later.turnId);
    const {startBridge}=await import('../../../packages/agent/dist/bridge.js'),bridge=await startBridge(node.featureServices.archiveReader,input);
    try{
      const response=await fetch(bridge.url+'/conversation_search',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({query:'GENERATED_FUTURE_TURN'})});
      const page=await response.json() as any;assert.equal(response.status,200,JSON.stringify(page));assert.deepEqual(page.data.items,[]);
      return {...answer('Generated bounded answer'),trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
    }catch(error){failure=error;throw error;}finally{await bridge.close();}
  }}});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  conversationId=node.conversations.main().id;
  node.conversations.append(node.conversations.get(conversationId),{question:'Generated earlier turn',after},answer('Generated earlier answer'));
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId,question:'Generated bounded query',after}});
  if(failure)throw failure;assert.equal(response.statusCode,200,response.body);
});

test('history tools enforce the current selection and erase answer previews and attachment names',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-c3-history-'));let node!:Awaited<ReturnType<typeof buildApp>>,failure:unknown;
  let selected='';let mode:'selection'|'erased'='selection';
  node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
    const bridge=await startBridge(node.featureServices.archiveReader,input);
    try{
      const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const result=await response.json() as any;assert.equal(response.status,200,JSON.stringify(result));return result.data;};
      const found=await call('conversation_search',{query:mode==='selection'?'GENERATED_NEEDLE':'GENERATED_NEEDLE_ERASED',limit:1});
      if(mode==='selection'){
        assert.equal(found.items.length,1,JSON.stringify(found));assert.match(JSON.stringify(found),/GENERATED_VISIBLE/);assert.doesNotMatch(JSON.stringify(found),/GENERATED_HIDDEN/);assert.equal(found.items[0].answerTruncated,true);
        assert.deepEqual(found.items[0].references,[selected]);
        assert.equal('seq' in found.items[0],false,'filtered sequence gaps cannot reveal hidden turns');
        assert.equal(typeof found.nextCursor,'string');assert.throws(()=>JSON.parse(Buffer.from(found.nextCursor,'base64url').toString()));
        const second=await call('conversation_search',{query:'GENERATED_NEEDLE',limit:1,cursor:found.nextCursor});
        const third=await call('conversation_search',{query:'GENERATED_NEEDLE',limit:1,cursor:second.nextCursor});
        assert.equal(third.nextCursor,null);assert.equal(new Set([found.items[0].id,second.items[0].id,third.items[0].id]).size,3);
        const opened=await call('conversation_history',{id:third.items[0].id});assert.equal(opened.items[0].id,third.items[0].id);
        const long=await call('conversation_history',{id:found.items[0].id});assert.equal(long.items[0].textRange.nextOffset,3999);
        const tail=await call('conversation_history',{id:found.items[0].id,offset:long.items[0].textRange.nextOffset});assert.equal(tail.items[0].textRange.nextOffset,null);
        assert.equal(long.items[0].answer+tail.items[0].answer,longAnswer);
        const split=await fetch(bridge.url+'/conversation_history',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:found.items[0].id,offset:4000})});assert.notEqual(split.status,200);
        assert.doesNotMatch(JSON.stringify({second,third,opened}),/GENERATED_HIDDEN/);
        const wrong=await fetch(bridge.url+'/conversation_search',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({query:'different',cursor:found.nextCursor})});assert.notEqual(wrong.status,200);
      }else{
        assert.equal(found.items.length,0,JSON.stringify(found));
        const history=await call('conversation_history',{limit:20});
        assert.doesNotMatch(JSON.stringify(history),/GENERATED_SECRET_ANSWER|GENERATED_PRIVATE_ATTACHMENT_NAME/);
      }
      return {...answer('Generated new result'),trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
    }catch(error){failure=error;throw error;}finally{await bridge.close();}
  }}});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  node.sources.register({id:'generated-c3-source',name:'Generated',kind:'upload',deviceId:'generated',platform:'import',retention:'archive'});
  const ids:string[]=[];
  for(const text of ['GENERATED_HIDDEN','GENERATED_VISIBLE']){
    const id=randomUUID();await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:text});ids.push(id);
  }
  selected=ids[1];const id=node.conversations.main().id;
  node.conversations.append(node.conversations.get(id),{question:'GENERATED_NEEDLE hidden',evidenceIds:[ids[0]]},answer('GENERATED_HIDDEN answer',ids.slice(0,1)));
  for(let i=0;i<2;i++)node.conversations.append(node.conversations.get(id),{question:'GENERATED_NEEDLE visible '+i,evidenceIds:[selected]},answer('GENERATED_VISIBLE answer',[selected]));
  node.conversations.append(node.conversations.get(id),{question:'GENERATED_NEEDLE visible',evidenceIds:[selected]},answer(longAnswer,[selected]));
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:id,question:'Recall selected history',evidenceIds:[selected]}});
  if(failure)throw failure;assert.equal(response.statusCode,200,response.body);
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),hash=createHash('sha256').update(bytes).digest('hex');
  const upload=node.files.begin({sourceId:'generated-c3-source',item:{externalId:'image',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'GENERATED_PRIVATE_ATTACHMENT_NAME',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:hash,sizeBytes:bytes.length},()=>{});
  node.files.part(upload.uploadId,0,bytes,()=>{});const attachment=(await node.files.commit(upload.uploadId,()=>{})).captureId;
  node.conversations.append(node.conversations.get(id),{question:'GENERATED_NEEDLE_ERASED',attachments:[{id:attachment,name:'GENERATED_PRIVATE_ATTACHMENT_NAME',mimeType:'image/png'}]},answer('GENERATED_SECRET_ANSWER',[attachment]));
  const before=await node.app.inject({url:`/api/conversations/${id}?limit=20`,headers});assert.match(before.body,/GENERATED_SECRET_ANSWER/);assert.match(before.body,/GENERATED_PRIVATE_ATTACHMENT_NAME/);
  node.store.invalidateConversationAnswers([attachment],true);node.store.delete(attachment);mode='erased';
  const after=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:id,question:'Recall the erased history',evidenceIds:[attachment]}});
  // A deleted selection itself must be rejected; use an unrestricted follow-up
  // to inspect the erased projection and its search through the actual bridge.
  assert.notEqual(after.statusCode,200);
  const follow=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:id,question:'Recall the erased history',evidenceIds:null}});
  if(failure)throw failure;assert.equal(follow.statusCode,200,follow.body);
  const page=await node.app.inject({url:`/api/conversations/${id}?limit=20`,headers});assert.doesNotMatch(page.body,/GENERATED_SECRET_ANSWER|GENERATED_PRIVATE_ATTACHMENT_NAME/);
  const reference=await node.app.inject({url:`/api/conversations/${id}/references/${attachment}`,headers});assert.equal(reference.json().available,false);
});

test('queued history reads retain their original lineage and reject changed history before publication',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-c3-queue-')),after='2026-09-01T00:00:00Z';
  let node!:Awaited<ReturnType<typeof buildApp>>,target='',withdrawn='',mode:'answer'|'delete'|'withdraw'='answer',detected=false,failure:unknown;
  node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
    const bridge=await startBridge(node.featureServices.archiveReader,input);
    try{
      assert.ok(!input.conversation!.historyContext!.turns.some(turn=>turn.id===target),'target is outside the automatically supplied tail');
      const needle=mode==='answer'?'GENERATED_OLD_NEEDLE':mode==='delete'?'GENERATED_LATE_NEEDLE':'GENERATED_WITHDRAW_NEEDLE';
      const response=await fetch(bridge.url+'/conversation_search',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({query:needle})});
      const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.data.items.length,1,JSON.stringify({mode,value,scope:{after:input.after,evidenceIds:input.evidenceIds}}));assert.equal(value.data.items[0].id,target);
      if(mode==='answer'){
        const workId=input.traceContext!.operationId!;
        assert.ok(node.store.db.prepare('SELECT 1 FROM delegation_dependencies WHERE work_id=? AND evidence_id=?').get(workId,evidence),'the existing work receipt is pinned before the model can yield');
        const saved=node.delegation.journal.payload<{prepared:QueryInput}>(workId);
        assert.ok(saved.prepared.conversation!.historyContext!.turns.some(turn=>turn.id===target),'the same turn pin survives a resumed fragment');
        await input.hostControlChannel!.execute('delegation_workspace',{workspaceJson:JSON.stringify({supported:[{statement:'Generated saved historical interpretation',evidenceIds:[evidence]}]})});
      }
      if(mode!=='answer'){
        if(mode==='delete')node.store.db.prepare('DELETE FROM conversation_turns WHERE id=?').run(target);
        else node.store.invalidateConversationAnswers([withdrawn],true);
        try{input.assertContextAuthority?.();}catch{detected=true;}
      }
      return {...answer(mode==='answer'?'GENERATED_HISTORY_DERIVED':'GENERATED_LATE_RESULT'),trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
    }catch(error){failure=error;throw error;}finally{await bridge.close();}
  }}});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const evidence=randomUUID();await node.store.ingest({id:evidence,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated old evidence'});
  let id=node.conversations.main().id;
  const append=(question:string,ids:string[]=[])=>node.conversations.append(node.conversations.get(id),{question,after},answer('Generated stored answer',ids)).turnId;
  const old=append('GENERATED_OLD_NEEDLE',[evidence]);target=old;
  for(let i=0;i<21;i++)append('Generated filler '+i);
  const run=async()=>{
    const admitted=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:id,clientRequestId:randomUUID(),question:'Generated follow-up',scope:{kind:'all',after}}});
    assert.equal(admitted.statusCode,202,admitted.body);const messageId=admitted.json().id;
    for(let i=0;i<200;i++){
      const response=await node.app.inject({url:`/api/conversations/${id}/messages/${messageId}`,headers}),message=response.json();
      if(['completed','failed','cancelled'].includes(message.status))return {messageId,message};
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Generated queue did not settle');
  };
  const first=await run();if(failure)throw failure;assert.equal(first.message.status,'completed');
  const saved=node.conversations.get(id).turns.find(turn=>turn.id===first.messageId)!;
  assert.ok(saved.result!.evidenceDependencies!.ids.includes(evidence),'on-demand old evidence remains a dependency of the answer');
  node.store.invalidateConversationAnswers([evidence],true);
  assert.equal(node.conversations.get(id).turns.find(turn=>turn.id===first.messageId)!.evidenceDeleted,true);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM delegation_payloads WHERE work_id=?').get('query:'+first.messageId)!.n,0,'erasure clears the saved workspace as well as the answer');
  node.conversations.delete(id);id=node.conversations.main().id;
  target=append('GENERATED_LATE_NEEDLE');for(let i=0;i<21;i++)append('Generated later filler '+i);mode='delete';
  const late=await run();if(failure)throw failure;
  assert.equal(detected,true,'the history pin is rechecked after the old turn is removed');
  assert.equal(late.message.status,'failed');
  assert.doesNotMatch(JSON.stringify(node.conversations.get(id)),/GENERATED_LATE_RESULT/);
  node.conversations.delete(id);id=node.conversations.main().id;withdrawn=randomUUID();
  await node.store.ingest({id:withdrawn,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated withdrawn evidence'});
  target=append('GENERATED_WITHDRAW_NEEDLE',[withdrawn]);for(let i=0;i<21;i++)append('Generated final filler '+i);mode='withdraw';detected=false;
  const revoked=await run();if(failure)throw failure;
  assert.equal(detected,true,'a withdrawn original invalidates the newly read historical turn');
  assert.equal(revoked.message.status,'failed');
  assert.doesNotMatch(JSON.stringify(node.conversations.get(id)),/GENERATED_LATE_RESULT/);
});
