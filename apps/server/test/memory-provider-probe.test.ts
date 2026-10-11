import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerPluginRuntime} from '../src/plugin-runtime.js';
import {WorkerMemoryProvider} from '../src/worker-memory-provider.js';
import {probeMemoryProvider} from '../src/memory-provider-probe.js';

// Generated executable plugin fixture uses the actual child worker ABI and a
// durable file. It proves host capability checks, never semantic retrieval or
// a third-party package's correctness. health deliberately lies and is unused.
const source=`import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function createMemoryProvider({directory,mode}){
 const file=directory+'/state.json';let state={records:[],ops:{}};
 if(mode!=='volatile')try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const save=()=>mode==='volatile'?Promise.resolve():writeFile(file,JSON.stringify(state));
 const receipt=(i,status)=>({opId:i.opId,namespace:i.namespace,key:i.key,payloadDigest:hash({namespace:i.namespace,key:i.key,...(status==='applied'?{memory:i.memory}:{})}),state:status,...(status==='removed'?{currentRemoved:true}:{}),eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z'});
 return {
  health(){throw Error('Self-advertised health must never be called');},
  async put(i){if(mode==='blocked'){await writeFile(directory+'/blocked','generated-only');await new Promise(()=>{});}const payload=hash(i),prior=state.ops[i.opId];if(prior){if(prior.payload!==payload)throw Error('conflict');return prior.receipt;}const existing=state.records.find(v=>same(v.namespace,i.namespace)&&same(v.key,i.key));if(existing&&!same(existing.memory,i.memory))throw Error('immutable_conflict');if(!existing)state.records.push({namespace:i.namespace,key:i.key,memory:i.memory});const r=receipt(i,'applied');state.ops[i.opId]={payload,receipt:r};await save();return r;},
  async read(i){return state.records.find(v=>(mode==='cross-scope'||same(v.namespace,i.namespace))&&same(v.key,i.key))?.memory??null;},
  async export(i){return state.records.filter(v=>same(v.namespace,i.namespace));},
  async search(i){return state.records.filter(v=>same(v.namespace,i.namespace)&&(mode==='ignore-keys'||i.keys===undefined||i.keys.some(k=>same(k,v.key)))).slice(0,i.limit??10);},
  async remove(i){const payload=hash(i),prior=state.ops[i.opId];if(prior){if(prior.payload!==payload)throw Error('conflict');return prior.receipt;}const old=state.records;state.records=old.filter(v=>!(same(v.namespace,i.namespace)&&same(v.key,i.key)));const r=receipt(i,'removed');state.ops[i.opId]={payload,receipt:r};if(mode==='unsafe-delete'){const current=state.records;state.records=old;await save();state.records=current;}else await save();return r;},
  async close(){}
 };
}`;
async function fixture(t:any,mode='persistent'){
 const directory=await mkdtemp(join(tmpdir(),'mote-worker-host-probe-')),entry=join(directory,'fixture.mjs');await writeFile(entry,source,{mode:0o600});let provider=new WorkerMemoryProvider(new WorkerPluginRuntime(entry,{directory,mode},directory)),restarts=0;
 t.after(async()=>{await provider.close();await rm(directory,{recursive:true,force:true});});
 return {directory,get provider(){return provider;},get restarts(){return restarts;},async restart(){await provider.close();restarts++;provider=new WorkerMemoryProvider(new WorkerPluginRuntime(entry,{directory,mode},directory));return provider;}};
}
const namespace={ownerId:'real-owner-must-not-be-touched',instanceId:'generated-plugin-instance',bindingRevision:1};
test('host canary proves real trusted worker persistence across two restarts and scoped immutable history',async t=>{
 const f=await fixture(t),health=await probeMemoryProvider({provider:f.provider,restart:()=>f.restart(),namespace,providerId:'generated-plugin',version:'1.0.0'});
 assert.equal(health.ready,true,JSON.stringify(health.problems));assert.equal(f.restarts,2);assert.deepEqual(health.verified,{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false});
 const retained=JSON.parse(await readFile(join(f.directory,'state.json'),'utf8'));assert.equal(retained.records.length,0,'canary current records are cleaned up');assert.ok(Object.keys(retained.ops).length>0,'durable deletion receipts remain without a physical-erasure claim');assert.ok(Object.values(retained.ops).every((value:any)=>value.receipt.namespace.ownerId!==namespace.ownerId));
});
for(const [mode,phase] of [['volatile','worker_restart'],['cross-scope','namespace_isolation'],['ignore-keys','scoped_search_export'],['unsafe-delete','delete_restart']] as const)test('host canary rejects '+mode+' despite worker-declared capabilities',async t=>{
 const f=await fixture(t,mode),health=await probeMemoryProvider({provider:f.provider,restart:()=>f.restart(),namespace,providerId:'generated-plugin',version:'1.0.0'});assert.equal(health.ready,false);assert.ok(health.problems.includes('host_probe_failed:'+phase),JSON.stringify(health.problems));assert.equal(health.verified.physicalErase,false);
});
test('revoking a hung host canary closes its real worker without admitting another operation',async t=>{
 const f=await fixture(t,'blocked'),controller=new AbortController(),pending=probeMemoryProvider({provider:f.provider,restart:()=>f.restart(),namespace,providerId:'generated-plugin',version:'1.0.0',signal:controller.signal});
 let entered=false;for(let attempt=0;attempt<100&&!entered;attempt++){try{await readFile(join(f.directory,'blocked'));entered=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
 assert.equal(entered,true,'the real child worker received the canary write');controller.abort();const health=await pending;assert.equal(health.ready,false);assert.deepEqual(health.problems,['host_probe_revoked']);assert.equal(f.restarts,0);
});
