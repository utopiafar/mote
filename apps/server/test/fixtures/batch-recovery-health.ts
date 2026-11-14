import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../../src/app.js';
import {materialId} from '../../src/materials.js';

// A generated 2 h 16 min recording, exported as 4,097 two-second segments.
// The only profile is the parent's temporary directory; the model is disabled.
const directory=process.argv[2],total=4097,sourceId='generated-batch-recording';
const transcript={durationMs:total*2000,coverage:'full' as const,engine:'generated',segments:Array.from({length:total},(_,index)=>({
  startMs:index*2000,endMs:(index+1)*2000,speaker:'Generated speaker',text:'Generated exact recording segment '+index+' with original provenance and timing.',
}))};
const config={dataDir:directory,token:'generated-batch-recovery-owner-only',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:200e6,maxExportBytes:1e6,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
const build=()=>buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>assert.fail('An unconfigured model must never execute'),close:async()=>{}}});
let node=await build(),batchId:string,ids:string[],captureId:string;
try{
  await node.app.ready();
  node.sources.register({id:sourceId,name:'Generated recording export',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  const receipt=await node.files.transcriptRevision(sourceId,{externalId:'recording',kind:'file',title:'Generated recording',observedAt:'2026-10-01T00:00:00.000Z',document:{recordedAt:'2026-09-30T23:00:00.000Z',occurredAt:'2026-09-30T22:00:00.000Z',timeBasis:'occurred',contentRole:'transcript'}},
    transcript.segments.map(segment=>segment.text).join('\n'),transcript,()=>{});
  captureId=receipt.id;
  while(await node.materialOrganizer.tick(500)){}
  const material=node.materials.get(materialId(sourceId,'recording'))!;
  ids=node.materials.input(material.ref,['extracted-text'])!.evidenceIds;
  assert.equal(ids.length,total);
  const batch=node.batchProcessing.submit({operationId:'generated-recording:'+randomUUID(),requestId:randomUUID(),items:[{question:'Review the complete generated recording',evidenceIds:ids}]},{kind:'manual',identities:[],connections:[]});
  batchId=batch.id;
  // Persist work before its first attempt, then recover it after a real reopen.
  node.store.db.prepare("UPDATE execution_steps SET available_at=? WHERE kind='batch.item'").run(Date.now()+60000);
}finally{await node.app.close();}

node=await build();
try{
  await node.app.listen({host:'127.0.0.1',port:0});
  const state=()=>node.batchProcessing.progress(batchId),queued=state(),step=queued.items[0];
  assert.equal(step.state,'waiting');assert.equal(step.attempts,0);
  const executionIdentity=()=>node.store.db.prepare('SELECT id,operation_id,input,attempts,fence,lease_until,created_at,recovery_deadline FROM execution_steps WHERE id=?').get(step.id);
  const queuedExecution=executionIdentity();
  const originals=()=>({
    source:node.sources.getSource(sourceId),capture:node.store.evidence([captureId]),
    bytes:Buffer.concat([...node.files.bytes(captureId)]),
    artifacts:node.store.db.prepare('SELECT * FROM file_artifacts WHERE capture_id=? ORDER BY rowid').all(captureId),
    chunks:node.store.db.prepare('SELECT * FROM file_chunks WHERE capture_id=? ORDER BY ordinal').all(captureId),
    material:node.materials.get(materialId(sourceId,'recording')),
    anchors:node.materials.evidence(ids),
  });
  const saved=originals(),privateTasks=node.store.db.prepare('SELECT * FROM task_records WHERE operation_id=? ORDER BY rowid').all(step.operationId);
  process.send!({type:'ready',port:(node.app.server.address() as {port:number}).port});
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  process.send!({type:'recovering'});
  let timerMs:number|undefined,transactionDuring:boolean|undefined;
  const began=performance.now(),timer=setTimeout(()=>{timerMs=performance.now()-began;transactionDuring=node.store.db.isTransaction;},0);
  node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='batch.item'").run();
  await node.executor.tick();
  const durationMs=performance.now()-began;
  // Allow the already-scheduled timer and the parent's pending socket to run
  // even when the admission's final setImmediate wins the first loop turn.
  await delay(10);clearTimeout(timer);
  const completed=state();
  assert.equal(completed.task.state,'waiting');assert.equal(completed.task.revision,queued.task.revision);
  assert.equal(completed.items.length,1);assert.equal(completed.items[0].state,'blocked');
  assert.equal(completed.items[0].error,'model_not_configured');assert.equal(completed.items[0].attempts,0);
  assert.deepEqual(completed.items[0].input,step.input);assert.equal(completed.items[0].operationId,step.operationId);
  assert.deepEqual(executionIdentity(),queuedExecution,'admission must not spend attempts, claim a lease or rewrite the execution identity and recovery window');
  assert.deepEqual(node.store.db.prepare('SELECT * FROM task_records WHERE operation_id=? ORDER BY rowid').all(step.operationId),privateTasks,'unavailable-model recovery must preserve private tasks, original fingerprints, request identity and timestamps');
  assert.deepEqual(originals(),saved,'recovery must preserve original bytes/text, segment timing, source declarations and Material revision');
  process.send!({type:'done',durationMs,timerMs,transactionDuring,total});
}finally{await node.app.close();}
process.disconnect();
