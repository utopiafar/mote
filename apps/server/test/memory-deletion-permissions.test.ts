import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-deletion-permissions-'));
  const config:Config={dataDir:directory,token:'generated-deletion-permissions-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentConcurrency:1};
  let modelCalls=0;
  const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>{
    modelCalls++;return {answer:'Generated fixture answer',citations:[],trace:[],runId:'fixture'};
  }})});
  const abort=new AbortController(),releases=new Set<()=>void>(),pending:Promise<unknown>[]=[];
  t.after(async()=>{
    for(const release of releases)release();
    abort.abort();
    await Promise.allSettled(pending);
    await node.app.close();rmSync(directory,{recursive:true,force:true});
  });
  node.sources.register({id:'generated-files',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'android',retention:'archive'});
  const bytes=Buffer.from('Generated recording fixture');
  const begin=node.files.begin({sourceId:'generated-files',item:{externalId:'private-b',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
  node.files.part(begin.uploadId,0,bytes,()=>{});
  const privateId=(await node.files.commit(begin.uploadId,()=>{})).id;
  const candidateId=(await node.sources.upsert('generated-files',{externalId:'candidate-a',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated candidate A.'})).id;
  assert.notEqual(candidateId,privateId);
  assert.equal(node.featureServices.evidenceReader.deletionContextAllowed(privateId),true);

  async function queued(changePermission:()=>void|Promise<void>){
    let release!:()=>void,entered!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    releases.add(release);
    const blocker=node.featureServices.agentGate.run(async()=>{entered();await held;});
    pending.push(blocker);await started;
    // The private root is disclosed only through the deleted conclusion. It is
    // deliberately absent from the candidate's normal evidenceIds.
    const query=node.featureServices.queryAgent({question:'Generated deletion review',signal:abort.signal,evidenceIds:[candidateId],derivedContextEvidenceIds:[privateId],taskContext:{turns:[],untrustedMemoryDraft:{deletion:{statement:'Generated private B-derived conclusion'}}}})
      .then(result=>({result,error:undefined}),error=>({result:undefined,error}));
    pending.push(query);
    try{
      for(let i=0;i<100&&node.featureServices.agentGate.snapshot().waiting===0;i++)await new Promise<void>(resolve=>setImmediate(resolve));
      assert.deepEqual(node.featureServices.agentGate.snapshot(),{active:1,waiting:1,limit:1});
      await changePermission();
    }finally{
      release();releases.delete(release);await blocker;
    }
    const outcome=await query;
    assert.equal(outcome.result,undefined);
    assert.equal(outcome.error?.statusCode,409);
    assert.match(outcome.error?.message??'',/Derived context evidence is no longer permitted/);
    assert.equal(modelCalls,0,'the denied deleted conclusion never reaches the model');
  }
  return {node,privateId,queued};
}

test('a deletion context root becoming local-only while queued prevents remote model admission',async t=>{
  const f=await fixture(t);
  await f.queued(()=>{f.node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(f.privateId);});
});

test('a deletion context root revoked while queued prevents model admission',async t=>{
  const f=await fixture(t);
  await f.queued(async()=>{
    await f.node.sources.upsert('generated-files',{externalId:'private-b',revision:'2',observedAt:'2026-02-01T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:true});
  });
});
