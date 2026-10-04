import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {memoryRecipeScope} from '../src/memory-recipe-settings.js';

const personal={id:'mote.personal-memory',version:'2'},coding={id:'mote.coding-memory',version:'1'};
const body='I felt proud of finishing the prototype. For the prototype retry path I prevented duplicate writes with an idempotency key and verified the retry.';
const understanding=(input:QueryInput)=>input.question.includes('FINAL UNIFIED RESPONSE CONTRACT:\nInterpret every supplied part');
async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-auto-recipes-'));
  const config:Config={dataKey:undefined,dataDir:directory,token:'generated-auto-recipes-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const calls:QueryInput[]=[],control:{failCoding:boolean;emptyResults?:boolean;duringReview?:(input:QueryInput)=>Promise<void>}={failCoding:false};
  let node:Awaited<ReturnType<typeof buildApp>>;
  const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput):Promise<QueryResult>=>{
    calls.push(input);const evidence=node.memories.readEvidence(input.evidenceIds!)[0],id=evidence.id;
    const common={uncertainty:'Generated session only.',admission:{layer:'memory',reason:'Generated fixture personal experience or evidenced retry decision',scope:'Generated prototype',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]};
    const candidates=[{...common,domain:'personal',title:'Generated pride',statement:`Felt proud of finishing the prototype [${id}]`},{...common,domain:'coding',title:'Generated retry decision',statement:`For the prototype retry path, used an idempotency key and verified retry [${id}]`,coding:{kind:'decision',scope:'session',applicability:'Generated prototype retry path',validation:'tested'}}];
    let values=candidates;
    if(input.traceContext?.phase==='review'){
      await control.duringReview?.(input);
      const recipe=node.memoryPipeline.get(input.traceContext!.jobId!).recipes![0];
      if(recipe.id===coding.id&&control.failCoding)throw Error('Generated independent review failure');
      values=recipe.id===coding.id?[candidates[1]]:[candidates[0]];
    }
    const range=input.evidenceRanges?.find(range=>range.id===id),quote=range?evidence.ocrText.slice(range.offset,range.offset+Math.min(range.length,120)):evidence.ocrText.slice(0,120);
    return {answer:JSON.stringify(understanding(input)?{summary:'Generated bounded conversation interpretation',evidence:[{id,quote,offset:range?.offset??0}],workRecords:[],events:[],memoryCandidates:control.emptyResults?[]:values,actionCues:[]}:{memories:control.emptyResults?[]:values}),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()};
  }}};
  node=await buildApp(config,dependencies);await node.app.ready();
  const configure=async(recipes:typeof personal[]|null,sourceId?:string)=>{
    const r=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers:{authorization:'Bearer '+config.token},payload:{recipes,...(sourceId?{sourceId}:{})}});
    assert.equal(r.statusCode,200,r.body);return r.json();
  };
  const source=(id:string,isCoding=false)=>{node.sources.register({id,name:'Generated '+id,kind:isCoding?'coding-agent':'custom',deviceId:'fixture',platform:'import'});node.sourcePipelines.configure(id,{memory:true,settleSeconds:0});};
  const add=async(sourceId:string,externalId:string,isCoding=false,revision='1',text=body)=>node.sources.upsert(sourceId,{externalId,revision,observedAt:'2020-01-01T00:00:00Z',kind:'message',layer:'original',text,...(isCoding?{document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated',sessionId:externalId,eventId:'event',role:'user',part:0,parts:1}}}:{document:{contentRole:'authored'}})});
  const publish=async()=>{await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);};
  const run=async()=>{node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);await Promise.all(node.memoryPipeline.list().filter(j=>['queued','running','waiting_for_model'].includes(j.status)).map(j=>node.memoryPipeline.run(j.id)));};
  // Hold scheduling, not admission: the production queue still creates and
  // claims actual jobs. Tests can then choose a producer or restart before work.
  const queue=async()=>{const p=node.memoryPipeline;node.sourcePipelines.drainMemory({create:input=>p.create(input),get:id=>p.get(id),cancel:id=>p.cancel(id),run:async()=>{}},true,100);await new Promise(resolve=>setImmediate(resolve));};
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  return {get node(){return node;},jobs:()=>node.memoryPipeline.list().map(j=>node.memoryPipeline.get(j.id)),calls,control,config,configure,source,add,publish,run,queue,count:(phase:string)=>calls.filter(c=>c.traceContext?.phase===phase||phase==='extract'&&understanding(c)).length,async restart(){await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();}};
}

test('owner-selected automatic recipes share one generation, support source overrides and survive restart without replay',async t=>{
  const f=await fixture(t);assert.deepEqual(f.node.memoryRecipeSettings.selection().map(b=>b.recipe.id),[personal.id]);assert.equal(f.calls.length,0);
  await f.configure([personal,coding]);f.source('diary');f.source('coding-source',true);
  const override=await f.configure([coding],'coding-source');assert.equal(override.inherited,false);
  await f.add('diary','first');await f.add('coding-source','second',true);await f.publish();await f.run();
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);
  const jobs=f.jobs();assert.equal(jobs.length,3);assert.ok(jobs.every(j=>j.status==='completed'&&j.automaticGrant));
  const shared=jobs.filter(j=>j.automaticGrant!.sourceId==='diary');assert.equal(new Set(shared.map(j=>j.contextTime)).size,1);
  const products=jobs.flatMap(j=>j.memoryIds.map(id=>f.node.memories.get(id)));assert.equal(products.length,3);
  const one=products.find(m=>m.domain==='personal')!;f.node.memories.publish(one.id);
  await f.restart();await f.publish();await f.run();assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);
  await f.configure([coding]);assert.equal(f.node.memories.get(one.id).status,'published','disabling does not erase confirmed products');
  const inherited=await f.configure(null,'coding-source');assert.equal(inherited.inherited,true);assert.equal(inherited.items[0].binding.recipe.id,coding.id);
  const material=f.node.materials.list({sourceId:'diary'}).items[0];
  const inputKey=shared[0].automaticGrant!.inputKey;
  f.node.materialMemoryWork.observe(material.id,['source-body'],{inputKey,change:'rebuild'});await f.run();assert.equal(f.calls.length,5,'changing selection or rebuilding does not backfill');
});

test('receipt pins scopes before publication; later enablement, version replacement and duplicate delivery do not backfill',async t=>{
  const f=await fixture(t);f.source('diary');await f.configure([]);
  const denied=await f.add('diary','disabled');await f.configure([personal,coding]);await f.publish();await f.run();assert.equal(f.calls.length,0);
  assert.equal((await f.add('diary','disabled')).duplicate,true);await f.publish();await f.run();assert.equal(f.calls.length,0);
  assert.ok(f.node.materials.list({sourceId:'diary'}).items.some(m=>f.node.materialMemoryWork.readyForMemory(m.ref)));
  await f.add('diary','pinned');
  await f.configure([{id:personal.id,version:'1'},coding]);await f.publish();await f.run();
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),1);assert.equal(f.jobs()[0].recipes![0].id,coding.id);
  const grants=f.node.store.db.prepare('SELECT binding_json,revoked_at FROM memory_input_authorizations WHERE capture_id!=? AND authorized=1').all(denied.id);
  assert.equal(grants.length,2);assert.equal(grants.filter(g=>g.revoked_at!==null).length,1);
  await f.configure([personal,coding]);await f.run();assert.equal(f.calls.length,2,'reenabling cannot restore a revoked receipt');
  await f.add('diary','fresh');await f.publish();await f.run();assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);
  const disabledMaterial=f.node.materials.list({sourceId:'diary'}).items.find(m=>m.origin.externalId==='disabled')!;
  const explicit=f.node.memoryPipeline.create({evidenceIds:f.node.materials.evidenceIds(disabledMaterial.ref),recipes:[personal]});
  assert.equal((await f.node.memoryPipeline.run(explicit.id)).status,'completed','explicit owner work may process the otherwise unauthorized history');
});

test('one automatic reviewer failure preserves the other product and retries only the failed review after restart',async t=>{
  const f=await fixture(t);f.source('diary');await f.configure([personal,coding]);f.control.failCoding=true;
  await f.add('diary','first');await f.publish();await f.run();
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),2);
  const failed=f.jobs().find(j=>j.status==='failed')!,completed=f.jobs().find(j=>j.status==='completed')!;
  assert.equal(failed.recipes![0].id,coding.id);const original=f.node.memories.get(completed.memoryIds[0]);
  await f.restart();f.control.failCoding=false;
  assert.equal((await f.node.memoryPipeline.retry(failed.id)).status,'completed');assert.equal(f.count('extract'),1);assert.equal(f.count('review'),3);
  assert.deepEqual(f.node.memories.get(original.id),original);
});

test('removing one scope cancels its in-flight result without vetoing an enabled sibling',async t=>{
  const f=await fixture(t);f.source('diary');await f.configure([personal,coding]);
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  f.control.duringReview=async input=>{if(f.node.memoryPipeline.get(input.traceContext!.jobId!).recipes![0].id===personal.id){entered();await held;}};
  await f.add('diary','first');await f.publish();const running=f.run();await reached;
  await f.configure([coding]);release();await running;await f.run();
  const jobs=f.jobs();assert.equal(jobs.find(j=>j.recipes![0].id===personal.id)!.status,'cancelled');
  assert.equal(jobs.find(j=>j.recipes![0].id===personal.id)!.memoryIds.length,0);
  assert.equal(jobs.find(j=>j.recipes![0].id===coding.id)!.status,'completed');
  assert.ok(f.node.memories.list().every(m=>m.domain==='coding'));
  await f.configure([personal,coding]);await f.run();assert.equal(f.node.memories.list().length,1,'reenabling cannot revive the cancelled receipt');
});

test('unavailable selected definitions preserve their pinned receipt and do not prevent another scope from running',async t=>{
  const f=await fixture(t);f.source('diary');const definition={id:'generated.review',version:'1',input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'Generated reviewer'};
  const stop=f.node.memoryStrategies.registerReview(definition);
  const custom={id:'generated.recipe',version:'1'};
  f.node.memoryStrategies.registerRecipe({...custom,extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:definition.id,version:definition.version}});
  await f.configure([custom,personal]);await f.add('diary','first');stop();await f.publish();await f.run();
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),1);
  const view=f.node.memoryRecipeSettings.view();assert.equal(view.items.find(i=>i.binding.recipe.id===custom.id)!.available,false);
  const scope=memoryRecipeScope(view.items.find(i=>i.binding.recipe.id===custom.id)!.binding);
  const pending=f.node.store.db.prepare('SELECT job_id,error FROM material_memory_requests WHERE scope=?').get(scope);
  assert.equal(pending!.job_id,null);assert.equal(pending!.error,'memory_enqueue_failed');
  assert.equal(f.jobs().length,1,'no fallback policy is silently substituted');
});

for(const mutation of ['delete','prune','revise'] as const)test(`a cancelled automatic producer preserves a shared stage for an authorized sibling across restart; ${mutation} still invalidates it`,async t=>{
  const f=await fixture(t);f.source('diary');await f.configure([personal,coding]);const original=await f.add('diary','first');await f.publish();await f.queue();
  const producer=f.jobs().find(j=>j.recipes![0].id===personal.id)!;
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  f.control.duringReview=async()=>{enter();await held;};const running=f.node.memoryPipeline.run(producer.id);await entered;
  const draft=f.node.store.db.prepare('SELECT batch_id,input_hash,json FROM memory_extraction_drafts WHERE shared=1').get()!;
  assert.ok(producer.batches.some(b=>b.id===draft.batch_id),'the cancelled job actually produced the shared draft');
  await f.configure([coding]);release();assert.equal((await running).status,'cancelled');
  assert.equal(f.node.memories.list().length,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  assert.deepEqual(f.node.store.db.prepare('SELECT batch_id,input_hash,json FROM memory_extraction_drafts WHERE shared=1').get(),draft);
  await f.restart();f.control.duringReview=undefined;await f.run();
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),2);
  const sibling=f.jobs().find(j=>j.recipes![0].id===coding.id)!;assert.equal(sibling.status,'completed');assert.equal(sibling.memoryIds.length,1);
  const memory=f.node.memories.get(sibling.memoryIds[0]);assert.equal(memory.domain,'coding');
  assert.equal(memory.reviewReceipt!.draftRunId,JSON.parse(String(draft.json)).runId);
  assert.equal(f.node.memoryPipeline.get(producer.id).status,'cancelled');
  if(mutation==='delete')assert.equal(f.node.store.delete(original.id).deleted,1);
  else if(mutation==='prune')assert.ok(f.node.store.prune('2021-01-01T00:00:00Z')>=1);
  else await f.node.sources.upsert('diary',{externalId:'first',revision:'2',observedAt:'2020-01-02T00:00:00Z',kind:'message',layer:'original',text:'A corrected original.',document:{contentRole:'authored'}});
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  if(mutation==='revise'){assert.equal(f.node.memories.get(memory.id).status,'stale');assert.equal(f.node.store.evidence([original.id]).length,1,'revision keeps historical original');}
  else assert.throws(()=>f.node.memories.get(memory.id),{statusCode:404});
});

test('automatic source jobs use the owner batch limit and keep existing ranges through setting changes and restart',async t=>{
  const f=await fixture(t);f.control.emptyResults=true;f.source('diary');f.source('coding-source',true);
  const setBudget=async(batchCharacters:number)=>{const r=await f.node.app.inject({method:'PUT',url:'/api/memory-settings',headers:{authorization:'Bearer '+f.config.token},payload:{...f.node.lifecycle.settings(),batchCharacters}});assert.equal(r.statusCode,200,r.body);};
  await setBudget(257);const text='🍃'.repeat(700)+body;
  await f.add('diary','first',false,'1',text);await f.add('coding-source','first',true,'1',text);await f.publish();await f.queue();
  const jobs=f.jobs();assert.equal(jobs.length,2);
  const assertBudget=(job:typeof jobs[number],limit:number)=>{assert.equal(job.batchCharacters,limit);const ranges=job.batches.flatMap(b=>b.evidenceRanges);assert.ok(job.batches.every(b=>b.evidenceRanges.reduce((n,r)=>n+r.length,0)<=limit));
    for(const evidence of f.node.memories.readEvidence(job.evidenceIds)){let end=0;for(const range of ranges.filter(r=>r.id===evidence.id).sort((a,b)=>a.offset-b.offset)){assert.equal(range.offset,end);end+=range.length;const part=evidence.ocrText.slice(range.offset,end);assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part),'Unicode remains whole');}assert.equal(end,evidence.ocrText.length);}
  };
  for(const job of jobs)assertBudget(job,257);
  const before=jobs.map(j=>({id:j.id,ranges:j.batches.map(b=>b.evidenceRanges)}));
  await setBudget(512);await f.restart();for(const old of before)assert.deepEqual(f.node.memoryPipeline.get(old.id).batches.map(b=>b.evidenceRanges),old.ranges);
  await f.add('diary','second',false,'1',text);await f.publish();await f.queue();
  const fresh=f.jobs().find(j=>!before.some(old=>old.id===j.id))!;assertBudget(fresh,512);assert.ok(fresh.batches.some(b=>b.evidenceRanges.some(r=>r.length>257)));
  await f.run();assert.ok(f.jobs().every(j=>j.status==='completed'));assert.equal(f.jobs().length,3,'settings changes do not create history jobs');
  for(const call of f.calls.filter(c=>c.traceContext?.phase==='extract'||understanding(c)))assert.ok(call.evidenceRanges!.reduce((n,r)=>n+r.length,0)<=(call.traceContext!.jobId===fresh.id?512:257));
});

test('the commit boundary rejects revoked automatic permission even without local cancellation notification',async t=>{
  const f=await fixture(t);f.source('diary');await f.configure([personal,coding]);
  f.node.memoryRecipeSettings.onApplied=undefined; // Simulate another host saving the shared policy.
  f.control.duringReview=async input=>{if(f.node.memoryPipeline.get(input.traceContext!.jobId!).recipes![0].id===personal.id)await f.configure([coding]);};
  await f.add('diary','first');await f.publish();await f.run();
  const rejected=f.jobs().find(j=>j.recipes![0].id===personal.id)!;
  assert.equal(rejected.status,'failed');assert.equal(rejected.memoryIds.length,0);
  assert.equal(rejected.batches[0].errorCode,'memory_authorization_revoked');
  assert.equal(f.jobs().find(j=>j.recipes![0].id===coding.id)!.status,'completed');
});

test('enablement and revocation commit atomically and collector credentials cannot change either',async t=>{
  const f=await fixture(t);f.source('diary');await f.configure([personal,coding]);await f.add('diary','first');
  const before=f.node.memoryRecipeSettings.view(),hook=f.node.memoryRecipeSettings.onChange;
  f.node.memoryRecipeSettings.onChange=()=>{hook?.();throw Error('Generated config failure');};
  assert.throws(()=>f.node.memoryRecipeSettings.configure({recipes:[]}),/Generated config failure/);
  assert.deepEqual(f.node.memoryRecipeSettings.view(),before);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE revoked_at IS NOT NULL').get()!.n,0);
  f.node.memoryRecipeSettings.onChange=hook;
  const {invitation}=f.node.connections.invite({serverUrl:'http://127.0.0.1:3456',label:'Generated collector'});
  const credential=await f.node.connections.redeem({code:invitation.code,deviceId:'generated-other-device',deviceName:'Generated',platform:'macos'});
  for(const method of ['GET','PUT'] as const){const response=await f.node.app.inject({method,url:'/api/memory-recipe-settings',headers:{authorization:'Bearer '+credential.token},...(method==='PUT'?{payload:{recipes:[]}}:{})});assert.equal(response.statusCode,403);}
  f.node.store.logicalBytes();
  assert.ok(Number(f.node.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='memory_recipe_settings'").get()!.bytes)>0);
  await f.publish();assert.ok(Number(f.node.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='material_memory_requests'").get()!.bytes)>0);
});
