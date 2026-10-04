import {readAgentCredential} from './login-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {requestMemoryIntegration} from '../src/memory-integration.js';
import {MemoryStrategies} from '../src/memory-strategies.js';

const ref=(name:string,version='1')=>({id:'fixture.'+name,version});
const integrate={...ref('integrator'),input:'memory-cards@1',output:'memory-candidates@1',permissions:['memory.read','evidence.read'],prompt:'GENERATED_INTEGRATOR_1'};
const review={...ref('review'),input:'memory-candidates@1',output:'memory-candidates@1',permissions:['memory.read','evidence.read'],policy:'GENERATED_REVIEW_1'};
const recipes=[{...ref('base'),integrate:ref('integrator'),review:ref('review')},{...ref('review-replaced'),integrate:ref('integrator'),review:ref('review','2')},{...ref('integrator-replaced'),integrate:ref('integrator','2'),review:ref('review','2')}];
const original='I felt proud of the prototype. An idempotency key prevented duplicate writes; I verified the retry.';

async function fixture(t:any){
 const directory=mkdtempSync(join(tmpdir(),'mote-integration-')),modulePath=join(directory,'generated-integrators.mjs');
 writeFileSync(modulePath,`export default {apiVersion:1,id:'generated-integrators',sourceKinds:[],create(ctx){const dispose=[];return {async init(){
  for(const value of ${JSON.stringify([integrate,{...integrate,version:'2',prompt:'GENERATED_INTEGRATOR_2'}])})dispose.push(ctx.memoryStrategies.registerIntegration(value));
  for(const value of ${JSON.stringify([review,{...review,version:'2',policy:'GENERATED_REVIEW_2'}])})dispose.push(ctx.memoryStrategies.registerReview(value));
  for(const value of ${JSON.stringify(recipes)})dispose.push(ctx.memoryStrategies.registerIntegrationRecipe(value));
 },close(){for(const fn of dispose.reverse())fn();}};}};`);
 const config:Config={dataDir:join(directory,'vault'),token:'generated-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,connectors:{directory:join(directory,'connectors'),modules:[modulePath]}};
 const calls:QueryInput[]=[],control:{duringQuery?:(input:QueryInput)=>Promise<void>|void;badQuote?:boolean;badRelation?:boolean;relation?:boolean;failCoding?:boolean;failPersonal?:boolean;reject?:boolean}={};
 const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput):Promise<QueryResult>=>{
  calls.push(input);await control.duringQuery?.(input);
  const cards=JSON.parse(input.question.slice(input.question.lastIndexOf('\n')+1)) as string[];
  const parents=cards.map(id=>node.memories.get(id));
  const coding=parents[0].domain==='coding',ids=[...new Set(parents.flatMap(m=>m.evidenceIds))],records=node.memories.readEvidence(ids);
  const claim={domain:coding?'coding':'personal',title:'Generated integration',statement:`${coding?'Verified retry method':'Prototype experience in context'} from the supplied originals ${ids.map(id=>'['+id+']').join(' ')}`,uncertainty:'Only generated evidence is available.',admission:{layer:'memory',reason:'Generated synthesis',scope:'Generated session',attribution:'user'},relatedMemoryIds:parents.map(m=>m.id),evidenceIds:ids,evidence:records.map(r=>({id:r.id,quote:control.badQuote&&input.traceContext?.phase==='review'?'Never stated in the original':r.ocrText.trim()})),...(coding?{coding:{kind:'pitfall',scope:'session',applicability:'Generated prototype',validation:'tested'}}:{}),...(control.relation?{relations:[{kind:'supersedes',memoryId:parents[0].id,fingerprint:parents[0].fingerprint,version:(parents[0].version??1)+(control.badRelation?1:0)}]}:{})};
  if(input.traceContext?.phase==='review'&&control.failCoding&&coding)throw Error('Generated coding review failure');
  if(input.traceContext?.phase==='review'&&control.failPersonal&&!coding)throw Error('Generated personal review failure');
  return {answer:JSON.stringify({memories:control.reject?[]:[claim]}),citations:records.map(r=>({id:r.id,capturedAt:r.capturedAt,appName:r.appName,excerpt:''})),trace:[],runId:randomUUID()};
 }}};
 const nodeDependencies={...dependencies,createModelAgent:async()=>dependencies.agent};
 let node=await buildApp(config,nodeDependencies);await node.app.ready();
 const disable=()=>{const s=node.lifecycle.settings();node.lifecycle.configure({...s,extraction:{...s.extraction,enabled:false},consolidation:{...s.consolidation,enabled:false,minChanges:1},insights:{...s.insights,enabled:false},working:{...s.working,enabled:false}});};disable();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const api=(method:'GET'|'PUT'|'POST',url:string,payload?:any,token=config.token)=>node.app.inject({method,url,payload,headers:{authorization:'Bearer '+token}});
 const add=async(name:string,both=false)=>{
  if(!node.sources.listSources().some(s=>s.id===name))node.sources.register({id:name,name:'Generated source',kind:'custom',deviceId:'generated',platform:'import'});
  const source=await node.sources.upsert(name,{externalId:'1',revision:'1',observedAt:'2026-09-01T00:00:00Z',kind:'message',layer:'original',text:original,document:{contentRole:'authored'}});
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  const material=node.materials.list({sourceId:name}).items[0],evidence=node.memories.readEvidence(node.materials.evidenceIds(material.ref)).find(r=>r.ocrText.includes(original))!;assert.ok(evidence);
  const base={uncertainty:'Generated fixture',admission:{layer:'memory',reason:'Explicit useful experience',scope:'Generated session',attribution:'user'},evidenceIds:[evidence.id],evidence:[{id:evidence.id,quote:original}]};
  const claims=[{...base,domain:'personal',title:'Prototype pride',statement:`Felt proud of the prototype [${evidence.id}]`},...(both?[{...base,domain:'coding',title:'Retry validation',statement:`Verified idempotency key retry [${evidence.id}]`,coding:{kind:'pitfall',scope:'session',applicability:'Generated prototype',validation:'tested'}}]:[])];
  const products=node.memories.extract({answer:JSON.stringify({memories:claims}),citations:[{id:evidence.id,capturedAt:evidence.capturedAt,appName:'Generated',excerpt:original}],trace:[],runId:randomUUID()},'generated',{requireAdmission:true}).items;
  return {source,products};
 };
 const queue=(ids:string[],recipe='base')=>requestMemoryIntegration({recipe:ref(recipe),memoryIds:ids},{lifecycle:node.lifecycle,memories:node.memories,pipeline:node.memoryPipeline});
 return {get node(){return node;},control,calls,add,api,queue,async restart(changed=false){await node.app.close();let next=config;if(changed){const changedPath=join(directory,'changed-integrator.mjs');writeFileSync(changedPath,readFileSync(modulePath,'utf8').replace('GENERATED_INTEGRATOR_1','Changed without a version'));next={...config,connectors:{...config.connectors!,modules:[changedPath]}};}node=await buildApp(next,nodeDependencies);await node.app.ready();},products:()=>node.memories.list().map(m=>node.memories.get(m.id)).filter(m=>m.tier==='consolidated'),view:()=>node.lifecycle.view().extensions.find(e=>e.id==='consolidation')!};
}

test('installed integration recipes independently replace generation and review through the owner API',async t=>{
 const f=await fixture(t),{products}=await f.add('diary',true);assert.equal(f.calls.length,0);
 assert.equal((await f.api('GET','/api/memory-integration-recipes')).json().items.filter((r:any)=>r.id.startsWith('fixture.')).length,3);
 f.node.memories.publish(products[0].id);
 for(const recipe of ['base','review-replaced','integrator-replaced']){
  const response=await f.api('POST','/api/memory-integrations',{recipe:ref(recipe),memoryIds:products.map(m=>m.id)});assert.equal(response.statusCode,202,response.body);await f.node.lifecycle.tick();assert.equal(f.view().error,undefined);assert.equal(f.view().active,undefined);
 }
 assert.equal(f.calls.length,12);assert.equal(f.products().length,6);assert.ok(f.calls.every(c=>c.skill==='memory-integration'&&!c.evidenceIds),JSON.stringify(f.calls.map(c=>({skill:c.skill,evidenceIds:c.evidenceIds}))));
 assert.equal(f.calls.filter(c=>c.question.startsWith('GENERATED_INTEGRATOR_1')).length,4);assert.equal(f.calls.filter(c=>c.question.startsWith('GENERATED_INTEGRATOR_2')).length,2);
 assert.equal(f.calls.filter(c=>c.question.startsWith('GENERATED_REVIEW_1')).length,2);assert.equal(f.calls.filter(c=>c.question.startsWith('GENERATED_REVIEW_2')).length,4);
 for(const m of f.products()){assert.equal(m.status,'published');assert.equal(m.integration?.review.fingerprint,m.reviewReceipt?.strategy?.fingerprint);assert.deepEqual(m.evidenceIds,products[0].evidenceIds);assert.ok(m.relatedMemoryIds?.length);}
 assert.equal(f.node.memories.get(products[0].id).status,'published');assert.equal(f.node.memories.get(products[0].id).supersededBy,undefined,'no replacement was requested by this recipe');
 const before=f.calls.length;await f.restart();await f.node.lifecycle.tick();assert.equal(f.calls.length,before,'installation and restart do not replay historical cards');
});

test('reviewed integration automatically supersedes both domains without invalidating its own checkpoint',async t=>{
 const f=await fixture(t),{products}=await f.add('automatic-relations',true);f.control.relation=true;
 f.queue(products.map(m=>m.id));await f.node.lifecycle.tick();assert.equal(f.view().error,undefined);assert.equal(f.products().length,2);
 for(const old of products){const current=f.node.memories.get(old.id),replacement=f.products().find(m=>m.domain===old.domain)!;assert.equal(current.supersededBy,replacement.id);assert.equal(replacement.status,'published');}
 const calls=f.calls.length;await f.restart();await f.node.lifecycle.tick();assert.equal(f.calls.length,calls);
});

test('selection changes process only subsequent events; disable preserves products and explicit history remains available',async t=>{
 const f=await fixture(t),old=await f.add('old');
 const first=(await f.api('PUT','/api/memory-integration-settings',{recipe:ref('base')})).json();assert.ok(first.afterSequence>0);
 const same=(await f.api('PUT','/api/memory-integration-settings',{recipe:ref('base')})).json();assert.deepEqual(same,first);
 const s=f.node.lifecycle.settings();f.node.lifecycle.configure({...s,consolidation:{...s.consolidation,enabled:true}});await f.node.lifecycle.tick();assert.equal(f.calls.length,0);
 const next=await f.add('next');await f.node.lifecycle.tick();assert.equal(f.calls.length,2);assert.deepEqual(f.products()[0].relatedMemoryIds,next.products.map(m=>m.id));
 await f.api('PUT','/api/memory-integration-settings',{recipe:null});await f.add('disabled');await f.node.lifecycle.tick();assert.equal(f.calls.length,2);assert.equal(f.products().length,1);
 f.queue(old.products.map(m=>m.id));await f.node.lifecycle.tick();assert.equal(f.calls.length,4);assert.equal(f.products().length,2,'explicit history is a separate authorization');
 await f.restart();await f.node.lifecycle.tick();assert.equal(f.calls.length,4);assert.equal(f.node.memoryIntegrationSettings.view().binding,null);
});

test('pinned plugin content cannot change under a queued manual task across restart',async t=>{
 const f=await fixture(t),{products}=await f.add('diary');const queued=f.queue(products.map(m=>m.id));
 await f.restart(true);await f.node.lifecycle.tick();assert.equal(f.calls.length,0);assert.equal(f.products().length,0);assert.equal(f.view().error,'workflow_409');
 await f.restart();f.node.lifecycle.retry('consolidation',queued.id);await f.node.lifecycle.tick();assert.equal(f.calls.length,2);assert.equal(f.products().length,1);
});

test('failed review resumes only unfinished domain after restart and preserves its completed sibling',async t=>{
 const f=await fixture(t),{products}=await f.add('diary',true);f.control.failCoding=true;const queued=f.queue(products.map(m=>m.id));
 await f.node.lifecycle.tick();assert.equal(f.products().length,1);assert.equal(f.products()[0].domain,'personal');assert.equal(f.calls.length,4);const preserved=JSON.stringify(f.products()[0]);
 f.control.failCoding=false;await f.restart();f.node.lifecycle.retry('consolidation',queued.id);await f.node.lifecycle.tick();
 assert.equal(f.calls.length,6,'open retrieval generation is repeated for the failed domain only');assert.equal(f.products().length,2);assert.ok(f.products().some(m=>JSON.stringify(m)===preserved));
});

for(const mutation of ['cancel','delete','parent-version','selection'] as const)test(`${mutation} during review fences late integration without silently rewriting parent cards`,async t=>{
 const f=await fixture(t),{products,source}=await f.add('diary');
 let queued:{id:string};
 if(mutation==='selection'){
  await f.api('PUT','/api/memory-integration-settings',{recipe:ref('base')});
  const s=f.node.lifecycle.settings();f.node.lifecycle.configure({...s,consolidation:{...s.consolidation,enabled:true}});f.node.memories.publish(products[0].id);
 }else queued=f.queue(products.map(m=>m.id));
 f.control.duringQuery=input=>{if(input.traceContext?.phase!=='review')return;f.control.duringQuery=undefined;
  if(mutation==='cancel')f.node.lifecycle.cancel('consolidation',queued!.id);
  else if(mutation==='delete')f.node.store.delete(source.id);
  else if(mutation==='parent-version')f.node.memories.publish(products[0].id);
  else f.node.memoryIntegrationSettings.configure({recipe:null});
 };
 await f.node.lifecycle.tick();assert.equal(f.products().length,0);assert.equal(f.calls.length,2);
 if(mutation==='cancel'){
  assert.equal(f.view().status,'cancelled');await f.node.lifecycle.tick();assert.equal(f.calls.length,2);
  const next=f.queue(products.map(m=>m.id));assert.notEqual(next.id,queued!.id);await f.node.lifecycle.tick();assert.equal(f.products().length,1,'owner can start another task after cancellation');
 }
});

for(const invalid of ['quote','relation'] as const)test(`plugin output cannot bypass host ${invalid} validation`,async t=>{
 const f=await fixture(t),{products}=await f.add('diary');f.control.badQuote=invalid==='quote';f.control.relation=invalid==='relation';f.control.badRelation=invalid==='relation';f.queue(products.map(m=>m.id));await f.node.lifecycle.tick();assert.equal(f.products().length,0);assert.ok(f.view().error);assert.equal(f.node.memories.get(products[0].id).supersededBy,undefined);
});

test('query agents cannot select policies, trigger paid history or control integration tasks',async t=>{
 const f=await fixture(t);const {invitation}=f.node.connections.invite({label:'Generated collector',serverUrl:'http://127.0.0.1',deviceId:'generated'}),credential=await readAgentCredential(f.node.connections);
 for(const [method,url,payload] of [['GET','/api/memory-integration-recipes'],['GET','/api/memory-integration-settings'],['PUT','/api/memory-integration-settings',{recipe:ref('base')}],['POST','/api/memory-integrations',{}],['POST',`/api/memory-integrations/${randomUUID()}/cancel`],['POST',`/api/memory-integrations/${randomUUID()}/retry`]] as const){const response=await f.api(method,url,payload,credential.token);assert.equal(response.statusCode,403,response.body);}assert.equal(f.calls.length,0);
});

test('integration pins are immutable, missing components never fall back and permissions are explicit',()=>{
 const registry=new MemoryStrategies(),remove=registry.registerIntegration(integrate);registry.registerReview(review);registry.registerIntegrationRecipe(recipes[0]);const selected=registry.resolveIntegration(ref('base'));
 assert.throws(()=>{selected.integrate.prompt='changed';},TypeError);remove();assert.throws(()=>registry.resolvePinnedIntegration(selected.binding),/unavailable/);
 assert.throws(()=>registry.registerIntegration({...integrate,prompt:'Changed without a version'}),/new version/);
 assert.throws(()=>registry.registerIntegration({...integrate,permissions:['memory.read','shell']}));
});

test('a failed first domain does not block a successful later domain; retry keeps its existing product',async t=>{
 const f=await fixture(t),{products}=await f.add('diary',true);f.control.failPersonal=true;const queued=f.queue(products.map(m=>m.id));await f.node.lifecycle.tick();
 assert.equal(f.products().length,1);assert.equal(f.products()[0].domain,'coding');assert.equal(f.calls.length,4);const preserved=f.products()[0].id;
 f.control.failPersonal=false;f.node.lifecycle.retry('consolidation',queued.id);await f.node.lifecycle.tick();assert.equal(f.calls.length,6);assert.equal(f.products().length,2);assert.ok(f.products().some(m=>m.id===preserved));
});

for(const phase of ['queued','review'] as const)test(`model configuration change while ${phase} cannot continue under another profile`,async t=>{
 const f=await fixture(t),{products}=await f.add('diary');f.queue(products.map(m=>m.id));
 const change=async()=>{const {apiKey:_apiKey,headers:_headers,extraBody:_extraBody,...settings}=f.node.modelSettings.current();await f.node.modelSettings.update({revision:f.node.modelSettings.view().revision,settings:{...settings,baseUrl:'http://127.0.0.1:9/v1',model:'changed-generated-model'}});};
 if(phase==='queued')await change();else f.control.duringQuery=async input=>{if(input.traceContext?.phase==='review'){f.control.duringQuery=undefined;await change();}};
 await f.node.lifecycle.tick();assert.equal(f.products().length,0);assert.equal(f.calls.length,phase==='queued'?0:2);assert.equal(f.view().error,'workflow_409');
});

test('empty integration is a completed decision and does not trigger unnecessary review or replay',async t=>{
 const f=await fixture(t),{products}=await f.add('diary');f.control.reject=true;f.queue(products.map(m=>m.id));await f.node.lifecycle.tick();assert.equal(f.calls.length,1);assert.equal(f.products().length,0);assert.equal(f.view().active,undefined);await f.node.lifecycle.tick();assert.equal(f.calls.length,1);
});

test('maximum declared strategy and card inputs fit the Agent question contract for both phases',async t=>{
 const f=await fixture(t),{products}=await f.add('diary');
 const parent=products[0],quote=parent.evidence![0].quote!,evidenceId=parent.evidenceIds[0],ids=[parent.id];
 for(let i=1;i<50;i++)ids.push(f.node.memories.extract({answer:JSON.stringify({memories:[{domain:'personal',title:'Generated '+i,statement:`Generated distinct statement ${i} [${evidenceId}]`,uncertainty:'Generated fixture',admission:parent.admission,evidenceIds:[evidenceId],evidence:[{id:evidenceId,quote}]}]}),citations:[{id:evidenceId,capturedAt:parent.evidence![0].capturedAt,appName:'Generated',excerpt:''}],trace:[],runId:randomUUID()},'fixture',{requireAdmission:true}).items[0].id);
 f.node.memoryStrategies.registerIntegration({...integrate,...ref('long-integrator'),prompt:'G'.repeat(16000)});
 f.node.memoryStrategies.registerReview({...review,...ref('long-review'),policy:'R'.repeat(16000)});
 f.node.memoryStrategies.registerIntegrationRecipe({...ref('long'),integrate:ref('long-integrator'),review:ref('long-review')});
 const s=f.node.lifecycle.settings();f.node.lifecycle.configure({...s,consolidation:{...s.consolidation,maxItems:50}});f.queue(ids,'long');await f.node.lifecycle.tick();
 assert.equal(f.calls.length,2);assert.equal(f.view().error,undefined);assert.ok(f.calls.every(c=>c.question.length<=20000),f.calls.map(c=>c.question.length).join(','));
});
