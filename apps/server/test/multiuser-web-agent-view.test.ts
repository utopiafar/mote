import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedMemoryFixture} from './fixtures/scoped-memory-host.js';

test('original Agent startup previews real owner Memory and read-only tools without admitting a model, and evidence stays query-scoped',async t=>{
 const f=await scopedMemoryFixture(t);for(const [user,label]of [[f.a,'A'],[f.b,'B']] as const){const material=await f.publish(user,label),job=await f.submit(user,[material.id]);await f.wait(user,job.id);}
 const before={calls:f.requests.length,runs:f.read(db=>db.prepare('SELECT count(*) n FROM ma_runs').get()!.n),jobs:f.read(db=>db.prepare('SELECT count(*) n FROM mm_jobs').get()!.n)};
 for(const [user,label,other]of [[f.a,'A','B'],[f.b,'B','A']] as const){
  const response=await f.request(user.token,'/api/agent-view/startup','POST',{question:'Generated preview '+label,timeZone:'UTC'});assert.equal(response.statusCode,200,response.body);const result=response.json();assert.equal(result.kind,'new_conversation_preview');assert.equal(result.modelCalls,0);assert.equal(result.context.request,'Generated preview '+label);assert.ok(result.context.untrustedMemoryLeads.some((item:any)=>item.title==='Generated '+label),response.body);assert.ok(!result.context.untrustedMemoryLeads.some((item:any)=>item.title==='Generated '+other));assert.ok(result.tools.includes('evidence'));const catalog=await f.request(user.token,'/api/agent-view/catalog?path=/context');assert.equal(catalog.statusCode,200,catalog.body);assert.equal(catalog.json().entries.length,3);assert.equal((result.context.untrustedEvidence?.length??0),0,'a preview never eagerly discloses original bodies');
  const memories=(await f.request(user.token,'/api/memories')).json(),id=memories.items[0].evidenceIds[0],read=await f.request(user.token,'/api/agent-view/evidence?id='+id+'&offset=0&length=12');assert.equal(read.statusCode,200,read.body);assert.equal(read.json().items[0].ocrText.length,12);assert.equal(read.json().items[0].textRange.offset,0);assert.ok(read.json().items[0].textRange.nextOffset>0);
  const denied=await f.request((user===f.a?f.b:f.a).token,'/api/agent-view/evidence?id='+id);assert.ok(denied.statusCode===404||(denied.statusCode===200&&denied.json().items.length===0),denied.body);
 }
 assert.equal(f.requests.length,before.calls);assert.equal(f.read(db=>db.prepare('SELECT count(*) n FROM ma_runs').get()!.n),before.runs);assert.equal(f.read(db=>db.prepare('SELECT count(*) n FROM mm_jobs').get()!.n),before.jobs);
 assert.equal((await f.request(f.a.token,'/api/agent-view/startup','POST',{question:'Generated',owner:f.b.userId})).statusCode,400);
 assert.equal((await f.request(undefined,'/api/agent-view/startup','POST',{})).statusCode,401);
});
