import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {CodingConversationContext} from '../src/coding-conversation-context.js';
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-coding-context-')),store=new Store(directory),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const original=randomUUID();await store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'message',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,ocrText:'Generated conversation source'});
 const text='User: Keep the monorepo. Proposed deadline Friday.\n'+'Generated unrelated bounded progress. '.repeat(410)+'\nUser: Correction: deadline is Monday. No physical device was tested.';
 const material=materials.publish({id:materialId('generated','session'),kind:'mote.coding-session',schemaVersion:5,title:'Generated',origin:{sourceId:'generated',externalId:'session',deviceId:'generated'},blocks:[{id:'conversation',kind:'text',format:'markdown',text,memberIds:['original']}],members:[{id:'original',kind:'capture',ref:'capture:'+original}],coverage:{state:'complete'},artifacts:[{key:'conversation',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 const ids=materials.evidenceIds(material.ref),pins=[materials.input(material.ref,['conversation'])!];
 const input={ref:material.ref,pins,configuration:{owner:'models' as const,fingerprint:'a'.repeat(64),revision:1,profileId:'generated',provider:'openai',model:'generated'},contextTime:'2026-01-02T00:00:00Z',signal:new AbortController().signal};
 return {store,materials,material,text,ids,input};
}
test('all bounded original pages are covered before consumers receive the overview; completed receipts avoid paid replay',async t=>{
 const f=await fixture(t);let calls=0;const covered:{id:string;offset:number;length:number}[]=[];
 const context=new CodingConversationContext(f.store,f.materials,async input=>{
  calls++;covered.push(...input.evidenceRanges!);assert.ok(input.evidenceRanges!.reduce((n,r)=>n+r.length,0)<=12000);
  assert.deepEqual(input.contextEvidenceDependencies?.ids,f.ids);assert.equal(input.contextEvidenceDependencies?.complete,true);
  if(calls>1)assert.match(input.taskContext?.previousSummary??'',/monorepo/);
  return {answer:JSON.stringify({summary:calls===1?'Keep the monorepo; Friday is a proposal.':'Keep the monorepo; user corrected Friday to Monday; device checks unperformed.'}),citations:[],trace:[],runId:randomUUID()};
 });
 const output=await context.prepare(f.input);assert.equal(calls,2);assert.equal(output.coveredCharacters,f.material.textLength);assert.match(output.summary,/monorepo.*corrected.*Monday.*unperformed/);
 assert.equal(covered.reduce((n,r)=>n+r.length,0),f.material.textLength);assert.equal(covered[0].offset,0);assert.equal(covered[1].offset,covered[0].length);
 assert.deepEqual(await context.prepare(f.input),output);assert.equal(calls,2);
});
test('interrupted context resumes its covered prefix without exposing a partial summary; source revisions reject cached results',async t=>{
 const f=await fixture(t);let calls=0;
 const failed=new CodingConversationContext(f.store,f.materials,async()=>{if(++calls===2)throw Error('generated model interruption');return {answer:JSON.stringify({summary:'Generated initial constraint retained'}),citations:[],trace:[],runId:randomUUID()};});
 await assert.rejects(failed.prepare(f.input),/interruption/);assert.equal(failed.get(failed.key(f.input))?.coveredCharacters,12000);
 const resumed=new CodingConversationContext(f.store,f.materials,async input=>{assert.match(input.taskContext?.previousSummary??'',/initial constraint/);return {answer:JSON.stringify({summary:'Generated complete constraint and correction overview'}),citations:[],trace:[],runId:randomUUID()};});
 assert.equal((await resumed.prepare(f.input)).coveredCharacters,f.material.textLength);
 const prior=f.materials.get(f.material.ref)!;
 f.materials.publish({id:prior.id,kind:prior.kind,schemaVersion:prior.schemaVersion,title:prior.title,origin:prior.origin,coverage:prior.coverage,artifacts:prior.artifacts,fidelity:prior.fidelity,retention:prior.retention,blocks:[{id:'new',kind:'text',format:'markdown',text:'Generated replacement',memberIds:['original']}],members:f.materials.members(f.material.ref).items},{expectedRevision:prior.revision});
 await assert.rejects(resumed.prepare(f.input),/changed/);
});
test('a partial selection cannot silently expand to the whole conversation',async t=>{
 const f=await fixture(t),context=new CodingConversationContext(f.store,f.materials,async()=>{throw Error('must not query');});
 await assert.rejects(context.prepare({...f.input,pins:[]}),/frozen owner selection/);
});
test('configuration changes fence page checkpoints and restored settings cannot reuse a mixed-model overview',async t=>{
 const f=await fixture(t),a=f.input.configuration,b={...a,fingerprint:'b'.repeat(64)};let selected=a,calls=0;
 const context=new CodingConversationContext(f.store,f.materials,async()=>{
  calls++;if(calls===2)selected=b;
  return {answer:JSON.stringify({summary:calls===1?'Generated A prefix':'Generated forbidden mixed result'}),citations:[],trace:[],runId:randomUUID(),configuration:a};
 },()=>selected);
 await assert.rejects(context.prepare(f.input),{code:'configuration_changed'});
 assert.equal(context.get(context.key(f.input))?.coveredCharacters,12000);assert.equal(context.get(context.key(f.input))?.summary,'Generated A prefix');
 await assert.rejects(context.prepare(f.input),{code:'configuration_changed'});assert.equal(calls,2,'changed configuration fails before another paid query');
 selected=a;
 const wrongReceipt=new CodingConversationContext(f.store,f.materials,async()=>({answer:JSON.stringify({summary:'Generated B response after settings returned to A'}),citations:[],trace:[],runId:randomUUID(),configuration:b}),()=>selected);
 await assert.rejects(wrongReceipt.prepare(f.input),{code:'configuration_changed'});assert.equal(wrongReceipt.get(wrongReceipt.key(f.input))?.summary,'Generated A prefix');
 const resumed=new CodingConversationContext(f.store,f.materials,async input=>{assert.equal(input.taskContext?.previousSummary,'Generated A prefix');return {answer:JSON.stringify({summary:'Generated clean A complete overview'}),citations:[],trace:[],runId:randomUUID(),configuration:a};},()=>selected);
 assert.equal((await resumed.prepare(f.input)).summary,'Generated clean A complete overview');
});
