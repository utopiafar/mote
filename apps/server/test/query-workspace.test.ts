import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime,registerQueryDelegation} from '../src/delegation-runtime.js';
function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-query-workspace-')),store=new Store(directory),engine=new ExecutionEngine(store),runtime=new DelegationRuntime(store,engine,{autoPump:false});
 t.after(async()=>{await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 registerQueryDelegation(runtime,{query:async input=>{await new Promise<void>(resolve=>{if(input.signal!.aborted)resolve();else input.signal!.addEventListener('abort',()=>resolve(),{once:true});});throw input.signal!.reason;}});
 runtime.start({id:'query:fixture',profileId:'query',goal:'Generated immutable question',input:{question:'Generated immutable question',hostRequest:{question:'Generated immutable question'},prepared:{question:'Generated immutable question',contextTime:'2026-10-10T00:00:00Z'}},allowedCapabilities:['context.research']});
 return {runtime,store,controls:runtime.controlChannel('query:fixture')};
}
test('query research checkpoints validate bounded structure and existing identities while preserving the original snapshot',async t=>{
 const {runtime,controls}=fixture(t);
 for(const workspace of [{supported:[{statement:'Invented unread source',evidenceIds:[randomUUID()]}]},{workerIds:['unknown']},{unresolved:['x'.repeat(12001)]},{request:'Override immutable question'}])await assert.rejects(controls.execute('delegation_workspace',{workspaceJson:JSON.stringify(workspace)}));
 assert.equal((await controls.execute('delegation_workspace',{})).data instanceof Object,true);
 await controls.execute('delegation_workspace',{workspaceJson:JSON.stringify({unresolved:['Check generated evidence'],searches:[{tool:'material_catalog',query:'generated'}]})});
 const saved=runtime.journal.payload<{question:string;prepared:{contextTime:string};queryWorkspace:{version:number;revision:number}}>('query:fixture');assert.equal(saved.question,'Generated immutable question');assert.equal(saved.prepared.contextTime,'2026-10-10T00:00:00Z');assert.equal(saved.queryWorkspace.version,1);assert.equal(saved.queryWorkspace.revision,1);
 assert.ok(!JSON.stringify(runtime.get('query:fixture')).includes('Check generated evidence'),'checkpoint remains private journal content');
});
test('workspace and executable-child wait commit atomically, with deletion clearing read but uncited research dependencies',async t=>{
 const {runtime,store,controls}=fixture(t),id=randomUUID();
 await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-10T00:00:00Z',durationMs:0,ocrText:'Generated read but uncited source'});runtime.recordEvidence('query:fixture',[id]);
 await controls.execute('delegation_submit',{units:[{id:'inspect',capabilityId:'context.research',title:'Generated check',goal:'Inspect one generated source',input:{question:'Inspect generated source'}}]});
 await controls.execute('delegation_workspace',{workspaceJson:JSON.stringify({unresolved:['Still needed'],inspected:[{id,start:0,end:10}]})});
 const before=runtime.journal.payload('query:fixture');
 await assert.rejects(controls.execute('delegation_yield',{workspaceJson:JSON.stringify({supported:[{statement:'Unknown dependency',evidenceIds:[randomUUID()]}]})}));
 assert.equal(runtime.get('query:fixture').wait,undefined);assert.deepEqual(runtime.journal.payload('query:fixture'),before);
 const yielded=await controls.execute('delegation_yield',{workspaceJson:JSON.stringify({unresolved:['Await generated worker'],inspected:[{id,start:0,end:10}],workerIds:['query:fixture:unit:inspect']})});assert.equal(yielded.yield,true);assert.deepEqual(runtime.get('query:fixture').wait?.unitIds,['query:fixture:unit:inspect']);
 assert.equal(runtime.journal.payload<{queryWorkspace:{revision:number}}>('query:fixture').queryWorkspace.revision,2);
 store.delete(id);assert.equal(runtime.get('query:fixture').status,'stale');assert.throws(()=>runtime.journal.payload('query:fixture'));assert.ok(!JSON.stringify(runtime.get('query:fixture')).includes('Await generated worker'));
});
