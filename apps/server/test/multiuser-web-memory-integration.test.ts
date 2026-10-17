import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {scopedMemoryFixture} from './fixtures/scoped-memory-host.js';

async function selected(f:Awaited<ReturnType<typeof scopedMemoryFixture>>,user:any,label:string){
 const material=await f.publish(user,label),job=await f.submit(user,[material.id]);await f.wait(user,job.id);
 const memory=(await f.request(user.token,'/api/memories')).json().items[0];assert.ok(memory&&memory.status==='published');
 return {memory,pin:{id:memory.id,version:memory.version,fingerprint:memory.fingerprint}};
}

test('original manual integration pins the selected Memory and recipe in the existing owned M07 job without enabling automatic work',async t=>{
 const f=await scopedMemoryFixture(t),a=await selected(f,f.a,'A'),b=await selected(f,f.b,'B'),recipes=(await f.request(f.a.token,'/api/memory/recipes')).json().integrations,recipe=recipes.find((item:any)=>item.available);assert.ok(recipe);
 const before=(await f.request(f.a.token,'/api/configuration')).json(),input={operationId:randomUUID(),recipe:{id:recipe.id,version:recipe.version},inputs:[a.pin]},response=await f.request(f.a.token,'/api/memory-integrations','POST',input);
 assert.equal(response.statusCode,200,response.body);const job=await f.wait(f.a,input.operationId);assert.equal(job.id,input.operationId);
 const saved=f.read(db=>JSON.parse(String(db.prepare('SELECT input FROM mm_jobs WHERE user_id=? AND id=?').get(f.a.userId,input.operationId)!.input)));
 assert.equal(saved.phase,'integrate');assert.equal(saved.automatic,false);assert.deepEqual(saved.related,[a.pin]);assert.deepEqual(saved.integration.recipe,{...recipe.binding.recipe});
 assert.deepEqual((await f.request(f.a.token,'/api/configuration')).json(),before,'manual recipe never changes global/default settings');
 assert.equal((await f.request(f.a.token,'/api/memories')).json().items.length,1,'zero newly consolidated memories is an honest successful result');
 const count=f.requests.length;assert.equal((await f.request(f.a.token,'/api/memory-integrations','POST',input)).statusCode,200);assert.equal(f.requests.length,count,'same operation has no second provider execution');
 assert.equal((await f.request(f.b.token,'/api/memory-integrations','POST',{...input,operationId:randomUUID()})).statusCode,404);
 assert.equal((await f.request(f.a.token,'/api/memory-integrations','POST',{...input,operationId:randomUUID(),inputs:[{...a.pin,fingerprint:'f'.repeat(64)}]})).statusCode,409);
 assert.equal((await f.request(f.a.token,'/api/memory-integrations','POST',{...input,operationId:randomUUID(),recipe:{...input.recipe,version:'999.0.0'}})).statusCode,409);
 const positive=await f.request(f.b.token,'/api/memory-integrations','POST',{...input,operationId:randomUUID(),inputs:[b.pin]});assert.equal(positive.statusCode,200,positive.body);await f.wait(f.b,positive.json().id);
 assert.ok(f.requests.every(call=>!call.raw.includes('GENERATED_MEMORY_A')||call.key==='GENERATED_A_KEY'));
});

test('a retired selected Memory version cannot be silently substituted during manual integration admission',async t=>{
 const f=await scopedMemoryFixture(t),a=await selected(f,f.a,'A'),recipe=(await f.request(f.a.token,'/api/memory/recipes')).json().integrations.find((item:any)=>item.available),changed=await f.request(f.a.token,'/api/memories/'+a.pin.id+'/correct','POST',{operationId:randomUUID(),correction:{version:a.pin.version,title:'Generated corrected A',statement:'Generated owner correction retained as new evidence.'}});assert.equal(changed.statusCode,200,changed.body);
 const count=f.requests.length,response=await f.request(f.a.token,'/api/memory-integrations','POST',{operationId:randomUUID(),recipe:{id:recipe.id,version:recipe.version},inputs:[a.pin]});assert.equal(response.statusCode,409,response.body);assert.equal(f.requests.length,count,'no new provider work is admitted for the old selection');
});

test('manual integration rechecks its original card under the admission transaction after an awaited model lease',async t=>{
 const f=await scopedMemoryFixture(t),a=await selected(f,f.a,'A'),recipe=(await f.request(f.a.token,'/api/memory/recipes')).json().integrations.find((item:any)=>item.available),configuration=f.node.configuration!,lease=configuration.leaseReference.bind(configuration),operationId=randomUUID();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);t.after(()=>release());
 configuration.leaseReference=async(...args:Parameters<typeof lease>)=>{const result=await lease(...args);if(args[2]==='memory-job:'+operationId){enter();await gate;}return result;};
 const pending=f.request(f.a.token,'/api/memory-integrations','POST',{operationId,recipe:{id:recipe.id,version:recipe.version},inputs:[a.pin]});await entered;
 const corrected=await f.request(f.a.token,'/api/memories/'+a.pin.id+'/correct','POST',{operationId:randomUUID(),correction:{version:a.pin.version,title:'Generated concurrent correction',statement:'Generated explicit current owner correction.'}});assert.equal(corrected.statusCode,200,corrected.body);assert.equal(await f.terminal(corrected.json().tasks.correct.id),'succeeded');assert.notDeepEqual(f.read(db=>db.prepare('SELECT version,fingerprint FROM mm_records WHERE user_id=? AND id=?').get(f.a.userId,a.pin.id)),{version:a.pin.version,fingerprint:a.pin.fingerprint},'the actual correction must retire the old pin before releasing the model lease');
 release();const response=await pending;assert.equal(response.statusCode,409,response.body);assert.equal(f.read(db=>Number(db.prepare('SELECT count(*) n FROM mm_jobs WHERE user_id=? AND id=?').get(f.a.userId,operationId)!.n)),0,'no stale Memory job or child grant is admitted after the lease await');
});

test('manual integration preserves selected personal and coding domains independently of the global default',async t=>{
 const f=await scopedMemoryFixture(t),personal=await selected(f,f.a,'A'),settings=(await f.request(f.a.token,'/api/memory')).json().settings;
 await f.replace(f.a.token,'memory',{...settings,profile:'coding'});
 f.answers.set('A',(_raw,keys,ids)=>({memories:[{domain:'coding',title:'Generated coding A',statement:'Nora prefers generated tea. ['+ids[0]+']',uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Generated coding preference',scope:'Generated A session',attribution:'third_party'},coding:{kind:'pitfall',scope:'session',applicability:'Generated prototype',validation:'tested'},evidenceIds:[ids[0]],evidence:[{id:ids[0],quote:'GENERATED_MEMORY_A: Nora prefers generated tea.'}]}],...(keys.length?{coverage:keys.map((key,index)=>({key,state:index===0?'checked':'no_candidates',candidateIndexes:index===0?[0]:[]}))}:{})}));
 const material=await f.publish(f.a,'A','same-source','generated-coding-original'),extract=await f.submit(f.a,[material.id]);await f.wait(f.a,extract.id);f.answers.delete('A');const coding=(await f.request(f.a.token,'/api/memories')).json().items.find((memory:any)=>memory.domain==='coding');assert.ok(coding);
 await f.replace(f.a.token,'memory',settings);const recipe=(await f.request(f.a.token,'/api/memory/recipes')).json().integrations.find((item:any)=>item.available),operationId=randomUUID(),response=await f.request(f.a.token,'/api/memory-integrations','POST',{operationId,recipe:{id:recipe.id,version:recipe.version},inputs:[personal.pin,{id:coding.id,version:coding.version,fingerprint:coding.fingerprint}]});assert.equal(response.statusCode,200,response.body);await f.wait(f.a,operationId);
 const batches=f.read(db=>db.prepare('SELECT input FROM mm_job_batches WHERE user_id=? AND job_id=? ORDER BY json_extract(input,\'$.profile\')').all(f.a.userId,operationId).map(row=>JSON.parse(String(row.input))));assert.deepEqual(batches.map(batch=>batch.profile),['coding','personal']);assert.deepEqual(batches.map(batch=>batch.related.map((pin:any)=>pin.id)),[[coding.id],[personal.pin.id]]);assert.equal((await f.request(f.a.token,'/api/memory')).json().settings.profile,'personal','explicit coding selection does not change the default');
});

test('an explicitly cancelled manual integration keeps the selected Memory and retires its original M07 children',async t=>{
 const f=await scopedMemoryFixture(t),a=await selected(f,f.a,'A'),recipe=(await f.request(f.a.token,'/api/memory/recipes')).json().integrations.find((item:any)=>item.available);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);f.gates.set('A',{entered:{promise:entered,resolve:enter},release:{promise:gate,resolve:release}});
 const response=await f.request(f.a.token,'/api/memory-integrations','POST',{operationId:randomUUID(),recipe:{id:recipe.id,version:recipe.version},inputs:[a.pin]});assert.equal(response.statusCode,200,response.body);await entered;const cancelled=await f.request(f.a.token,'/api/memory/jobs/'+response.json().id+'/cancel','POST',{});assert.equal(cancelled.statusCode,200,cancelled.body);release();f.gates.delete('A');
 const receipt=(await f.request(f.a.token,'/api/memory/jobs/'+response.json().id)).json();assert.equal(receipt.state,'cancelled');assert.ok(Object.values(receipt.tasks).every((task:any)=>task.state==='cancelled'));assert.equal((await f.request(f.a.token,'/api/memories/'+a.pin.id)).json().fingerprint,a.pin.fingerprint);assert.equal((await f.request(f.a.token,'/api/memories')).json().items.length,1);
});
