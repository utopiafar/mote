import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {UsageLedger} from '../src/usage.js';
import {MemoryStore} from '../src/memory.js';
import {semanticProcessor} from '../src/semantic-extraction.js';

const admissionWait=()=>new ProviderFailure({category:'blocked',code:'background_model_authorization_required',executionStarted:false,admissionWaiting:true,retryAfterMs:60000},'Background model processing needs owner authorization');

async function fixture(t:import('node:test').TestContext,query:(input:unknown)=>Promise<never>){
  const directory=mkdtempSync(join(tmpdir(),'mote-usage-wait-')),store=new Store(directory),ledger=new UsageLedger(store),memories=new MemoryStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const processor=semanticProcessor({store,memories,query:query as never,records:()=>[{id:'generated-r1',ocrText:'Generated segment text',capturedAt:'2026-11-03T00:00:00.000Z'} as never],selection:()=>({configured:true,fingerprint:'generated-fingerprint',provider:'generated-provider',model:'generated-model',profileId:'generated-profile'} as never),usage:ledger});
  const input={config:{modelFingerprint:'generated-fingerprint',artifactId:'generated-artifact'},artifacts:[{outputs:[{id:'generated-artifact',kind:'segment',revision:1,metadata:{complete:true,representatives:['generated-r1'],originalCharacters:22}}]}],execution:{operationId:'generated-op'},signal:new AbortController().signal};
  return {store,input};
}
const rows=(store:Store)=>store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String((row as {json:string}).json)) as {status:string});

test('an owner-authorization wait creates no usage row and repeats no failed metering',async t=>{
  const {store,input}=await fixture(t,async()=>{throw admissionWait();});
  await assert.rejects(semanticProcessor({store,memories:new MemoryStore(store),query:(async()=>{throw admissionWait();}) as never,records:()=>[{id:'generated-r1',ocrText:'Generated segment text'} as never],selection:()=>({configured:true,fingerprint:'generated-fingerprint',provider:'generated-provider',model:'generated-model',profileId:'generated-profile'} as never),usage:new UsageLedger(store)}).process(input as never));
  assert.equal(rows(store).length,0,'a pending owner authorization must not write model_usage');
});

test('a real model failure still finalizes one failed receipt',async t=>{
  const {store,input}=await fixture(t,async()=>{throw Error('Generated model failure');});
  await assert.rejects(semanticProcessor({store,memories:new MemoryStore(store),query:(async()=>{throw Error('Generated model failure');}) as never,records:()=>[{id:'generated-r1',ocrText:'Generated segment text'} as never],selection:()=>({configured:true,fingerprint:'generated-fingerprint',provider:'generated-provider',model:'generated-model',profileId:'generated-profile'} as never),usage:new UsageLedger(store)}).process(input as never));
  const usage=rows(store);assert.equal(usage.length,1);assert.equal(usage[0].status,'failed');
});
