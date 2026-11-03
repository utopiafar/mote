import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {UsageLedger} from '../src/usage.js';
import {MemoryStore} from '../src/memory.js';
import {semanticProcessor} from '../src/semantic-extraction.js';
import {BackgroundModelAuthorization} from '../src/background-model-authorization.js';

const connection={id:'generated-connection',fingerprint:'a'.repeat(64)};
type Outcome='success'|'failure'|'cancel'|'usage-wait'|'admitted-wait'|'trace-wait';

async function fixture(t:import('node:test').TestContext,{authorize,outcome}:{authorize:boolean;outcome:Outcome}){
  const directory=mkdtempSync(join(tmpdir(),'mote-usage-wait-')),store=new Store(directory),ledger=new UsageLedger(store),memories=new MemoryStore(store);
  const authorization=new BackgroundModelAuthorization(store,()=>[connection]);
  // Approval is prospective: authorize first, then receive a new original, so
  // the allowed cases exercise a genuinely admitted receipt.
  if(authorize)authorization.command({revision:authorization.view().revision,operationId:randomUUID(),action:'authorize',connections:[connection],scope:{sourceIds:null,dataKinds:['text']}});
  store.db.exec('BEGIN IMMEDIATE');authorization.receive('generated-original',{sourceId:'generated-source',dataKind:'text'});store.db.exec('COMMIT');
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  let sawOnTrace=false;
  const query=async(input:never)=>{
    const request=input as {onUsage?:(usage:{requests:number;reportedRequests:number;inputTokens:number;outputTokens:number;totalTokens:number})=>void;onTrace?:(event:unknown)=>void};sawOnTrace=typeof request.onTrace==='function';
    if(outcome==='trace-wait'){
      // A model trace is emitted before the host admission gate, so it must not
      // count as an admitted call when the real authorization rejects it.
      request.onTrace!({type:'model.started',stage:'model'});
      authorization.automatic('generated-work',['generated-original'],'semantic');
    }
    // Real durable admission: unapproved state throws the 60s pending failure.
    authorization.automatic('generated-work',['generated-original'],'semantic');
    if(outcome==='admitted-wait'){
      request.onTrace!({type:'model.admitted',stage:'model'});
    }else request.onUsage?.({requests:1,reportedRequests:1,inputTokens:5,outputTokens:2,totalTokens:7});
    if(outcome==='failure')throw Error('Generated model failure');
    if(outcome==='cancel')throw new ProviderFailure({category:'blocked',code:'cancelled',executionStarted:true},'Generated cancellation');
    if(outcome==='usage-wait'||outcome==='admitted-wait'){
      // A later call hits a real admission wait after the first call was admitted.
      authorization.command({revision:authorization.view().revision,operationId:randomUUID(),action:'pause'});
      authorization.automatic('generated-work-2',['generated-original'],'semantic');
    }
    return {answer:JSON.stringify({summary:'Generated summary',evidence:[],events:[],memoryCandidates:[],actionCues:[]}),citations:[],trace:[],runId:randomUUID()};
  };
  const processor=semanticProcessor({store,memories,query:query as never,records:()=>[{id:'generated-r1',ocrText:'Generated segment text',capturedAt:'2026-11-03T00:00:00.000Z'} as never],selection:()=>({configured:true,fingerprint:'generated-fingerprint',provider:'generated-provider',model:'generated-model',profileId:'generated-profile'} as never),usage:ledger});
  const input={config:{modelFingerprint:'generated-fingerprint',artifactId:'generated-artifact'},artifacts:[{outputs:[{id:'generated-artifact',kind:'segment',revision:1,metadata:{complete:true,representatives:['generated-r1'],originalCharacters:22}}]}],execution:{operationId:'generated-op'},signal:new AbortController().signal};
  const rows=()=>store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String((row as {json:string}).json)) as {status:string;tokens?:{totalTokens:number}});
  const admissionWait=(error:unknown)=>error instanceof ProviderFailure&&error.details.code==='background_model_authorization_required'&&error.details.admissionWaiting===true&&error.details.executionStarted===false;
  return {processor,input,rows,admissionWait,onTraceWired:()=>sawOnTrace};
}

test('repeated owner-authorization rechecks create no usage receipt and never consume a model start',async t=>{
  const f=await fixture(t,{authorize:false,outcome:'failure'});
  for(let attempt=0;attempt<3;attempt++)await assert.rejects(f.processor.process(f.input as never),f.admissionWait);
  assert.equal(f.rows().length,0,'a pending owner authorization must not write model_usage');
});

test('after authorization, a real model start and success finalize exactly one completed receipt',async t=>{
  const f=await fixture(t,{authorize:true,outcome:'success'});
  await f.processor.process(f.input as never);
  const usage=f.rows();assert.equal(usage.length,1);assert.equal(usage[0].status,'completed');assert.equal(usage[0].tokens?.totalTokens,7);
});

test('after authorization, a started model that fails finalizes exactly one failed receipt',async t=>{
  const f=await fixture(t,{authorize:true,outcome:'failure'});
  await assert.rejects(f.processor.process(f.input as never),/Generated model failure/);
  const usage=f.rows();assert.equal(usage.length,1);assert.equal(usage[0].status,'failed');
});

test('after authorization, a started model that is cancelled keeps the existing failed receipt contract',async t=>{
  const f=await fixture(t,{authorize:true,outcome:'cancel'});
  await assert.rejects(f.processor.process(f.input as never),error=>error instanceof ProviderFailure&&error.details.code==='cancelled'&&error.details.executionStarted===true);
  const usage=f.rows();assert.equal(usage.length,1);assert.equal(usage[0].status,'failed');
});

test('usage reported before a later admission wait is preserved as one failed receipt',async t=>{
  const f=await fixture(t,{authorize:true,outcome:'usage-wait'});
  await assert.rejects(f.processor.process(f.input as never),f.admissionWait);
  const usage=f.rows();assert.equal(usage.length,1,'reported tokens must not be discarded');assert.equal(usage[0].status,'failed');assert.equal(usage[0].tokens?.totalTokens,7);
});

test('a model trace without admission is discarded on a real authorization wait',async t=>{
  const f=await fixture(t,{authorize:false,outcome:'trace-wait'});
  await assert.rejects(f.processor.process(f.input as never),f.admissionWait);
  assert.equal(f.onTraceWired(),true,'the processor must wire onTrace into the real query surface');
  assert.equal(f.rows().length,0,'a trace is not an admitted model operation');
});

test('an admitted call without a token sample is retained when a later admission wait follows',async t=>{
  const f=await fixture(t,{authorize:true,outcome:'admitted-wait'});
  await assert.rejects(f.processor.process(f.input as never),f.admissionWait);
  assert.equal(f.onTraceWired(),true,'the processor must wire onTrace into the real query surface');
  const usage=f.rows();assert.equal(usage.length,1,'an admitted call must not be discarded');assert.equal(usage[0].status,'failed');assert.equal(usage[0].tokens,undefined);
});
