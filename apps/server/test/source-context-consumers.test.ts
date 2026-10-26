import {authorizeFixtureModels,withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {browseSourceContexts} from '../src/source-context-catalog.js';
import {contextIndex} from '../src/context-index.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {fileSummaryInputFingerprint} from '../src/file-summary-lineage.js';

test('source directory searches exact description text, preserves scope and fences pagination after a declaration update',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-source-directory-')),store=new Store(directory),sources=new SourceStore(store);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 for(let i=0;i<3;i++){const id='generated-'+i;sources.register({id,name:'Generated source '+i,deviceId:i===2?'other':'fixture',kind:'local-files',platform:'import'});sources.updateContext(id,{expectedVersion:0,description:'Generated Rare_Narrator_Label '+i});}
 const first=browseSourceContexts(store,sources,{deviceId:'fixture',query:'Rare_Narrator_Label',limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor);assert.equal(first.items[0].citationAuthority,false);assert.ok(first.items[0].sourceContextRef);
 const second=browseSourceContexts(store,sources,{deviceId:'fixture',query:'Rare_Narrator_Label',limit:1,cursor:first.nextCursor!});assert.equal(second.items[0].id,'generated-1');assert.equal(second.nextCursor,null);
 assert.equal(browseSourceContexts(store,sources,{query:'source 1'}).items[0].id,'generated-1');assert.equal(browseSourceContexts(store,sources,{query:'missing'}).items.length,0);
 const indexed=contextIndex(store,{page:()=>({items:[],nextCursor:null})} as any,sources,{path:'/context',query:'Rare_Narrator_Label',deviceId:'fixture'});assert.equal(indexed.entries.length,2,'root metadata search must discover source descriptions');
 sources.updateContext('generated-1',{expectedVersion:1,description:'Generated changed context'});assert.throws(()=>browseSourceContexts(store,sources,{deviceId:'fixture',query:'Rare_Narrator_Label',limit:1,cursor:first.nextCursor!}),/changed/);
});

test('HTTP file intake uses source description in summaries; changing it retires old work without ASR or historical model calls, then explicit retry reads current context',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-source-summary-')),token='generated-summary-context-owner';
 const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let transcriptions=0,summaryCalls=0,seen:string[]=[],holdNext=false,holdAsr=false,startHeld!:()=>void,releaseHeld!:()=>void,startAsr!:()=>void,releaseAsr!:()=>void;
 const heldStarted=new Promise<void>(resolve=>startHeld=resolve),heldGate=new Promise<void>(resolve=>releaseHeld=resolve),asrStarted=new Promise<void>(resolve=>startAsr=resolve),asrGate=new Promise<void>(resolve=>releaseAsr=resolve);
 const node=await buildApp(config,{backgroundWorker:false,transcriptionProvider:{transcribe:async()=>{transcriptions++;if(holdAsr){holdAsr=false;startAsr();await asrGate;}return {durationMs:10000,segments:Array.from({length:10},(_,i)=>({startMs:i*1000,endMs:(i+1)*1000,text:'Generated person planned a walk '+i,speaker:'SPEAKER_0'}))};}},createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
   const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(reader,input,40);
   try{const call=async(tool:string,args:Record<string,unknown>={})=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
    const results=await call('search_context');const id=results.data[0].id;
    const timelineIds:string[]=[];let cursor:string|null=null;do{const page=await call('timeline',{limit:3,...(cursor?{cursor}:{})});timelineIds.push(...page.data.map((record:{id:string})=>record.id));cursor=page.pagination.nextCursor;}while(cursor!==null);assert.equal(new Set(timelineIds).size,10,'the model can read the whole supplied file batch across bounded pages');assert.equal(JSON.stringify(results).includes('Generated call recording'),false,'statement body uses its own disclosure tool');
    let text='',offset:number|null=0,expectedFingerprint:string|undefined;while(offset!==null){const result=await call('attribution_context',{id,offset,length:12000,...(expectedFingerprint?{expectedFingerprint}:{})});expectedFingerprint??=result.data.contextFingerprint;text+=result.data.text;offset=result.data.nextOffset;}
    const context=JSON.parse(text);assert.deepEqual(input.contextSourceContextDependencies,context.sourceContextDeclarations,'the live file model request receives each disclosed pin before another provider request');seen.push(context.sourceContextStatements[0].description);summaryCalls++;if(holdNext){holdNext=false;startHeld();await heldGate;}
    return {answer:'Generated summary retains uncertain speaker identity',citations:[{id,capturedAt:results.data[0].capturedAt,appName:'Generated audio',excerpt:'Generated person planned a walk'}],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
   }finally{await bridge.close();}
 }})});
 t.after(async()=>{releaseHeld();releaseAsr();await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token},request=(method:'POST'|'PATCH'|'PUT',url:string,payload:unknown,extra={})=>node.app.inject({method,url,headers:{...headers,...extra},payload:payload as any});
 assert.equal((await request('POST','/api/sources',{id:'generated-audio',name:'Generated audio',kind:'local-files',deviceId:'fixture',platform:'import',retention:'archive'})).statusCode,200);
 const first='Generated call recording: I participated, but anonymous speaker labels do not identify me.';
 const declared=await request('PATCH','/api/sources/generated-audio/context',{expectedVersion:0,description:first});assert.equal(declared.statusCode,200,declared.body);
 const settings={...node.processing.view().settings,enabled:true,audioProcessor:'audio.http',summarize:true};await node.processing.save({revision:node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});
 await authorizeFixtureModels(node);
 const bytes=Buffer.from('Generated audio fixture bytes'),begun=await request('POST','/api/file-sync/v1/uploads',{sourceId:'generated-audio',item:{externalId:'generated.wav',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',title:'Generated audio',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)});assert.equal(begun.statusCode,200,begun.body);
 const uploadId=begun.json().uploadId;assert.equal((await request('PUT',`/api/file-sync/v1/uploads/${uploadId}/parts/0`,bytes,{'content-type':'application/octet-stream'})).statusCode,200);
 const committed=await request('POST',`/api/file-sync/v1/uploads/${uploadId}/commit`,{});assert.equal(committed.statusCode,200,committed.body);const id=committed.json().id;
 await node.processing.tick();assert.equal(transcriptions,1);assert.equal(summaryCalls,1);assert.equal(seen[0],first);const before=node.files.detail(id).artifacts.find((item:any)=>item.kind==='summary');assert.ok(before);
 const priorFingerprint=fileSummaryInputFingerprint(node.files,id),second='Generated call recording from a shared handset; neither anonymous speaker is confirmed as me.';
 const changed=await request('PATCH','/api/sources/generated-audio/context',{expectedVersion:1,description:second});assert.equal(changed.statusCode,200,changed.body);assert.notEqual(fileSummaryInputFingerprint(node.files,id),priorFingerprint);
 assert.equal(node.files.detail(id).artifacts.some((item:any)=>item.kind==='summary'),false);assert.equal(node.files.detail(id).job.summary_state,'cancelled');assert.equal(node.files.chunks(id).length,10);
 await node.processing.tick();assert.equal(transcriptions,1,'context update must preserve ASR');assert.equal(summaryCalls,1,'context update is not historical paid-work authorization');
 await withFixtureOwnerModelWork(node,async()=>node.processing.retry(id,'summary'),{identities:['capture:'+id]});await node.processing.tick();assert.equal(transcriptions,1);assert.equal(summaryCalls,2);assert.equal(seen[1],second);assert.ok(node.files.detail(id).artifacts.some((item:any)=>item.kind==='summary'));
 holdNext=true;await withFixtureOwnerModelWork(node,async()=>node.processing.retry(id,'summary'),{identities:['capture:'+id]});const running=node.processing.tick();await heldStarted;
 const held=node.processing.engine.list({operationId:'file:'+id,kind:'files.summary'}).items.find(step=>step.state==='running')!;assert.ok(held);
 const third='Generated call recording belongs to a visitor using this handset; my identity is unknown.';
 const during=await request('PATCH','/api/sources/generated-audio/context',{expectedVersion:2,description:third});assert.equal(during.statusCode,200,during.body);releaseHeld();await running;await node.processing.tick();
 assert.notEqual(node.processing.engine.get(held.id)?.state,'succeeded','late old-context summary cannot publish');assert.equal(summaryCalls,3,'context correction cannot authorize a replacement model call');assert.equal(node.files.detail(id).artifacts.some((item:any)=>item.kind==='summary'),false);assert.equal(transcriptions,1);
 const futureBytes=Buffer.from('Generated future audio fixture bytes'),future=await request('POST','/api/file-sync/v1/uploads',{sourceId:'generated-audio',item:{externalId:'future.wav',revision:'1',observedAt:'2026-10-02T00:00:00Z',kind:'file',layer:'original',title:'Generated future audio',text:'',mimeType:'audio/wav'},sizeBytes:futureBytes.length,sha256:sha256(futureBytes)});assert.equal(future.statusCode,200,future.body);
 const futureUploadId=future.json().uploadId;await request('PUT',`/api/file-sync/v1/uploads/${futureUploadId}/parts/0`,futureBytes,{'content-type':'application/octet-stream'});const futureCommit=await request('POST',`/api/file-sync/v1/uploads/${futureUploadId}/commit`,{});assert.equal(futureCommit.statusCode,200,futureCommit.body);
 holdAsr=true;const pending=node.processing.tick();await asrStarted;const fourth='Generated call recording: the pending file has its latest owner background before initial understanding.';
 const pendingChanged=await request('PATCH','/api/sources/generated-audio/context',{expectedVersion:3,description:fourth});assert.equal(pendingChanged.statusCode,200,pendingChanged.body);releaseAsr();await pending;
 assert.equal(transcriptions,2);assert.equal(summaryCalls,4);assert.equal(seen[3],fourth,'initial work pending ASR continues with the current source default');assert.ok(node.files.detail(futureCommit.json().id).artifacts.some((item:any)=>item.kind==='summary'));
 const {FileProcessing}=await import('../src/file-processing.js');await node.processing.close();const restarted=new FileProcessing(node.files,undefined,async records=>{summaryCalls++;return {answer:'Unexpected historical call',citations:records.map(record=>({id:record.id}))};});
 try{await restarted.tick();assert.equal(summaryCalls,4,'restart preserves historical withdrawal');assert.equal(node.files.chunks(id).length,10);}finally{await restarted.close();}

});
