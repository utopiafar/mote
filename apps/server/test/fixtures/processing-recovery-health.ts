import assert from 'node:assert/strict';
import {Store} from '../../src/store.js';
import {SourceStore} from '../../src/sources.js';
import {MaterialStore,materialId} from '../../src/materials.js';
import {ProcessingRuntime} from '../../src/processing-runtime.js';
import {buildApp} from '../../src/app.js';

// Only the parent-created temporary profile is used. No models or devices.
const directory=process.argv[2],sourceId='generated-recovery',total=64;
const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);
const ids:string[]=[],jobs:string[]=[];
const material=materialId(sourceId,'generated-group');
try{
  sources.register({id:sourceId,name:'Generated recovery',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  const result=await sources.upsertBatch(sourceId,Array.from({length:100},(_,n)=>({externalId:'generated-'+n,revision:'1',observedAt:'2026-10-01T00:00:00.000Z',title:'Generated '+n,text:'Generated evidence '+n,kind:'message',layer:'original'})));
  ids.push(...result.receipts.map(row=>row.id));
  materials.publish({id:material,kind:'fixture.generated',schemaVersion:1,title:'Generated group',origin:{sourceId,externalId:'generated-group'},
    members:ids.map(id=>({id,kind:'capture',ref:'capture:'+id})),blocks:ids.map((id,n)=>({id,kind:'text',format:'plain',text:'Generated evidence '+n,memberIds:[id]})),
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  runtime.registry.register({id:'fixture.retired',version:'1',lane:'semantic',async process(){assert.fail('An unavailable processor must never execute');}});
  for(let n=0;n<total;n++)jobs.push(runtime.enqueue([{name:'recover',processor:'fixture.retired',inputs:ids,config:{n}}]).recover);
  // Persist a not-yet-due backlog so the parent can first verify the real HTTP
  // listener, then make it due at a controlled recovery boundary after reopen.
  store.db.prepare("UPDATE execution_steps SET available_at=? WHERE kind='context-dag.semantic'").run(Date.now()+60000);
}finally{await runtime.close();store.close();}

const config={dataDir:directory,token:'synthetic-recovery-owner-token-only',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:1e9,maxExportBytes:1e6,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelProvider:'custom',modelProtocol:'openai-completions' as const,modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
const node=await buildApp(config,{backgroundWorker:false});
const rows=()=>jobs.map(id=>({...node.executor.get(id)!,...node.store.db.prepare('SELECT fence,lease_until leaseUntil,created_at createdAt,recovery_deadline recoveryDeadline FROM execution_steps WHERE id=?').get(id)!}));
const evidence=()=>node.store.evidence(ids);
const materialSnapshot=()=>{
  const value=node.materials.get(material)!;
  return {ref:value.ref,sequence:value.sequence,createdAt:value.createdAt,updatedAt:value.updatedAt,coverage:value.coverage,
    context:value.attributionContext,members:node.materials.members(material,{limit:200}),text:node.materials.read(material,{length:12000}).text};
};
try{
  await node.app.listen({host:'127.0.0.1',port:0});
  const address=node.app.server.address() as {port:number};
  process.send!({type:'ready',port:address.port});
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  const originals=evidence(),published=materialSnapshot(),queued=rows();
  assert.ok(queued.every(row=>row.state==='waiting'&&row.attempts===0));
  node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='context-dag.semantic'").run();
  process.send!({type:'recovering'});
  let timerDuring:number|undefined,transactionDuring:boolean|undefined;
  const timer=setTimeout(()=>{timerDuring=rows().filter(row=>row.state==='blocked').length;transactionDuring=node.store.db.isTransaction;},0);
  const began=performance.now();
  await node.workflows.tick();
  clearTimeout(timer);
  const completed=rows();
  for(const [index,row] of completed.entries()){
    assert.equal(row.state,'blocked');assert.equal(row.error,'processor_version_unavailable');assert.equal(row.attempts,0);
    assert.equal(row.fence,null);assert.equal(row.leaseUntil,0);assert.equal(row.availableAt,0);
    assert.deepEqual(row.input,queued[index].input);assert.equal(row.operationId,queued[index].operationId);
    assert.equal(row.createdAt,queued[index].createdAt);assert.equal(row.recoveryDeadline,queued[index].recoveryDeadline);
  }
  const projected=node.workflows.view().jobs;
  assert.equal(projected.length,total);
  for(const job of projected){
    assert.equal(job.state,'blocked');assert.equal(job.reason,'processor_version_unavailable');
    assert.equal(job.attempts,0);assert.equal(job.availableAt,0);assert.deepEqual(job.outputs,[]);
  }
  assert.deepEqual(evidence(),originals,'recovery must preserve original content, provenance and timestamps');
  assert.deepEqual(materialSnapshot(),published,'recovery must preserve material content, members, context and revision metadata');
  process.send!({type:'done',durationMs:performance.now()-began,timerDuring,transactionDuring,total:completed.length});
}finally{await node.app.close();}
process.disconnect();
