import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {AgentYieldError,type QueryInput} from '@mote/agent';
import {ProviderFailure,type WorkActivity} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import {materialId} from '../../server/src/materials.js';
import type {Config} from '../../server/src/config.js';
import {authorizeFixtureModels,fixtureTopicResult} from '../../server/test/fixtures/model-authorization.js';
import {fixtureMemoryPlan,fixtureMemoryWorkResult} from '../../server/test/fixtures/memory-planning.js';
import {Activity} from '../src/plugins/work/Activity.js';
import {RuntimeSettings,ExecutionQueueOverview} from '../src/RuntimeSettings.js';
import {resources} from '../src/resource-cache.js';
import {ApiError,type Api} from '../src/api.js';

configureLocale(()=> 'zh-CN');
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
async function until(read:()=>boolean,describe?:()=>unknown,advance?:()=>Promise<unknown>){for(let i=0;i<200;i++){if(read())return;await advance?.();await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Generated Host progress did not settle: '+JSON.stringify(describe?.()));}

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-progress-host-')),token='generated-progress-owner',headers={authorization:'Bearer '+token};
 const config:Config={dataDir:directory,dataKey:'66'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,interactiveConcurrency:1,agentConcurrency:2,llmConcurrency:2};
 const research=gate(),review=gate(),control={failReview:true,holdResearch:true,holdReview:true},calls:{phase?:string;question:string}[]=[];let node:Awaited<ReturnType<typeof buildApp>>,queryId='',slowUnit='';
 const answer=(text='Generated response')=>({answer:text,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[]}});
 const boot=()=>buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;calls.push({phase:input.traceContext?.phase,question:input.question});const plan=await fixtureMemoryPlan(input);if(plan)return plan;
  if(input.question==='Generated direct progress')return answer();
  if(['extract','review'].includes(input.traceContext?.phase??'')){
   const record=node.memories.readEvidence(input.evidenceIds!)[0];assert.ok(record);
   if(input.traceContext?.phase==='review'&&node.memoryPipeline.get(input.traceContext.jobId!).workPackage?.id===slowUnit){if(control.holdReview)await review.promise;if(control.failReview)throw new ProviderFailure({category:'permanent',code:'generated_review_failure'});}
   return fixtureMemoryWorkResult(input,{...answer(),answer:JSON.stringify({memories:[{title:'Generated durable preference',statement:'The generated owner keeps scoped written decisions ['+record.id+']',uncertainty:'Generated example only',admission:{layer:'memory',reason:'Generated explicit preference',scope:'This generated project',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText.trim()}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}]});
  }
  if(!input.hostControlChannel){if(input.question==='Generated slow research'&&control.holdResearch)await new Promise<void>((resolve,reject)=>{const abort=()=>reject(input.signal!.reason);input.signal!.addEventListener('abort',abort,{once:true});research.promise.then(()=>{input.signal!.removeEventListener('abort',abort);resolve();});});return answer('Generated private research product');}
  const units=(input.taskContext!.delegation as {units:unknown[]}).units;
  if(!units.length){await input.hostControlChannel.execute('delegation_submit',{units:['fast','slow'].map(id=>({id,capabilityId:'context.research',title:'Generated '+id+' question',goal:'Inspect this generated question',input:{question:'Generated '+id+' research'}}))});await input.hostControlChannel.execute('delegation_yield',{mode:'all'});throw new AgentYieldError();}
  return answer('Generated final research answer');
 }}});
 node=await boot();await authorizeFixtureModels(node);
 t.after(async()=>{research.release();review.release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const writes:{path:string;body:unknown}[]=[];
 const api={request:async<T>(path:string,init:RequestInit={}):Promise<T>=>{
  if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});
  const payload=typeof init.body==='string'?JSON.parse(init.body):undefined;if(init.method&&init.method!=='GET')writes.push({path,body:payload});
  const response=await node.app.inject({method:(init.method??'GET') as 'GET',url:path,headers,...(payload===undefined?{}:{payload})});if(response.statusCode>=400)throw new ApiError(response.body,response.statusCode);return response.json<T>();
 },setAgentTimeout:()=>{}} as Api;
 const activity=(id:string)=>api.request<WorkActivity>('/api/work-activity/'+encodeURIComponent(id)+'?limit=20');
 return {api,writes,control,calls,research,review,get node(){return node;},get queryId(){return queryId;},activity,
  async restart(){await node.app.close();node=await boot();},
  async researchStart(){queryId=randomUUID();const response=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:queryId,input:{question:'Generated two-question research'}}});assert.equal(response.statusCode,202,response.body);await until(()=>node.delegation.get('query:'+queryId).units.some(unit=>unit.status==='succeeded')&&node.delegation.get('query:'+queryId).units.some(unit=>unit.status==='running'));return 'query:'+queryId;},
  async memoryStart(){
   const sourceId='generated-progress-memory';assert.equal((await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:sourceId,name:'Generated Memory input',kind:'custom',deviceId:'generated-device',platform:'import'}})).statusCode,200);node.sourcePipelines.configure(sourceId,{settleSeconds:0});
   const selected=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers,payload:{sourceId,recipes:[{id:'mote.personal-memory',version:'5'}]}});assert.equal(selected.statusCode,200,selected.body);
   for(const index of [0,1]){const received=await node.app.inject({method:'PUT',url:'/api/sources/'+sourceId+'/items',headers,payload:{externalId:'point-'+index,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated preference '+index+' for scoped decisions.',document:{contentRole:'authored'}}});assert.equal(received.statusCode,200,received.body);}
   await node.materialOrganizer.tick(10);await node.sourcePipelines.tick(10);const catalog=node.materialMemoryWork.catalog();assert.equal(catalog.length,2);
   const id='memory-plan:'+randomUUID(),configuration=node.memoryPipeline.modelSnapshot().configuration,evidenceIds=node.memoryPipeline.evidenceDependencies(catalog.flatMap(candidate=>node.materialMemoryWork.planningEvidence(candidate.materialId,candidate.scope)));
   slowUnit=id+':unit:generated-1';node.delegation.start({id,operationId:id,profileId:'memory.plan',goal:'Process the two authorized generated inputs',input:{catalog,configuration,evidenceIds},scope:{contextTime:catalog.map(candidate=>candidate.contextTime).sort().at(-1)},allowedCapabilities:['memory.package']});await node.delegation.waitForPlan(id);await node.sourcePipelines.drainMemory(node.memoryPipeline,true);
   await until(()=>node.memoryPipeline.list().some(job=>job.status==='completed')&&calls.filter(call=>call.phase==='review').length===2);return {id:'memory-source:'+sourceId,parentId:id};
  },
 };
}

async function domFixture(t:TestContext){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/activity',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 dom.window.scrollTo=()=>{};const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.querySelector('#root')!);
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 return {root,d:dom.window.document,async activity(api:Api,id?:string){dom.window.history.replaceState(null,'',id?'#/activity?work='+encodeURIComponent(id):'#/activity');await act(async()=>root.render(null));await act(async()=>root.render(React.createElement(Activity,{api,onNavigate:()=>{},onOpen:()=>{}})));},async refresh(api:Api,id:string){await act(async()=>resources(api).get('/api/work-activity/'+encodeURIComponent(id)+'?limit=20').refresh());}};
}

test('real research activity keeps branch progress in cards and terminal details across owner cancel and restart',async t=>{
 const f=await fixture(t),ui=await domFixture(t),id=await f.researchStart(),work=await f.activity(id);
 assert.equal(work.state,'running');assert.equal(work.progress.mode,'semantic');assert.equal(work.progress.mode==='semantic'&&work.progress.completedBranches,1);assert.equal(work.progress.mode==='semantic'&&work.progress.totalBranches,2);
 await ui.activity(f.api);assert.match(ui.d.querySelector('.activity-card')!.textContent!,/1 \/ 2 个工作分支已完成/);assert.doesNotMatch(ui.d.querySelector('.activity-card')!.textContent!,/条资料|\d+%/);
 await ui.activity(f.api,id);assert.match(ui.d.body.textContent!,/1 \/ 2 个工作分支已完成/);assert.match(ui.d.body.textContent!,new RegExp(id));
 const cancelled=await f.api.request('/api/query-runs/'+f.queryId+'/cancel',{method:'POST',body:'{}'});assert.ok(cancelled);f.control.holdResearch=false;await f.restart();await ui.refresh(f.api,id);
 assert.equal((await f.activity(id)).state,'cancelled');assert.match(ui.d.body.textContent!,/1 \/ 2 个工作分支已完成/);assert.match(ui.d.body.textContent!,/已停止/);assert.doesNotMatch(ui.d.body.textContent!,/Generated private research product/);
});

test('completed research retains its branch counts after restart while a direct answer has no invented item or branch total',async t=>{
 const f=await fixture(t),ui=await domFixture(t),id=await f.researchStart();f.control.holdResearch=false;f.research.release();await until(()=>f.node.queryRuns.get(f.queryId).status==='completed');await f.restart();await ui.activity(f.api,id);
 assert.match(ui.d.body.textContent!,/2 \/ 2 个工作分支已完成/);assert.match(ui.d.body.textContent!,/已完成/);assert.doesNotMatch(ui.d.body.textContent!,/Generated private research product/);
 const directId=randomUUID();await f.api.request('/api/query-runs',{method:'POST',body:JSON.stringify({id:directId,input:{question:'Generated direct progress'}})});await until(()=>f.node.queryRuns.get(directId).status==='completed');await ui.activity(f.api,'query:'+directId);
 assert.equal((await f.activity('query:'+directId)).branches.length,0);assert.doesNotMatch(ui.d.body.textContent!,/0 \/ 0|0 条资料|\d+%/);assert.equal(ui.d.querySelector('progress'),null);
});

test('real Memory activity retains record progress and successful checkpoints through failure, owner retry and restart',async t=>{
 const f=await fixture(t),ui=await domFixture(t),ids=await f.memoryStart(),running=await f.activity(ids.id);
 assert.equal(running.progress.mode,'determinate');assert.equal(running.progress.mode==='determinate'&&running.progress.total,2);assert.equal(running.progress.mode==='determinate'&&running.progress.completed,1);
 await ui.activity(f.api,ids.id);assert.match(ui.d.body.textContent!,/已处理 1 \/ 2 条资料/);assert.equal(ui.d.querySelector('progress')!.value,1);
 f.control.holdReview=false;f.review.release();await until(()=>f.node.memoryPipeline.list().some(job=>job.status==='failed'));await f.node.delegation.tick();await ui.refresh(f.api,ids.id);assert.equal((await f.activity(ids.id)).state,'failed');assert.match(ui.d.body.textContent!,/已处理 1 \/ 2 条资料/);
 const completed=f.node.memoryPipeline.get(f.node.memoryPipeline.list().find(job=>job.status==='completed')!.id),failed=f.node.memoryPipeline.list().find(job=>job.status==='failed')!,checkpoint=f.node.store.db.prepare('SELECT * FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(completed.batches[0].id);assert.ok(checkpoint.length);
 await f.restart();assert.equal((await f.activity(ids.id)).progress.mode==='determinate'&&(await f.activity(ids.id)).progress.completed,1);f.control.failReview=false;await f.api.request('/api/memory-jobs/'+failed.id+'/retry',{method:'POST',body:'{}'});
 await until(()=>f.node.memoryPipeline.list().every(job=>job.status==='completed'));await until(()=>f.node.delegation.get(ids.parentId).status==='succeeded',()=>f.node.delegation.get(ids.parentId),async()=>{await f.node.sourcePipelines.drainMemory(f.node.memoryPipeline,true);await f.node.delegation.tick();});await ui.refresh(f.api,ids.id);assert.match(ui.d.body.textContent!,/已处理 2 \/ 2 条资料/);assert.equal(ui.d.querySelector('progress')!.value,2);
 assert.deepEqual(f.node.store.db.prepare('SELECT * FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(completed.batches[0].id),checkpoint);assert.equal(f.calls.filter(call=>call.phase==='extract').length,2);assert.equal(f.calls.filter(call=>call.phase==='review').length,3);
 const operation=await f.api.request<{operation:{state:string}}>('/api/operations/'+encodeURIComponent(ids.parentId));assert.equal(operation.operation.state,'succeeded');const current=await f.activity(ids.id);for(let replay=0;replay<3;replay++)await f.node.delegation.tick();assert.deepEqual((await f.activity(ids.id)).progress,current.progress);
});

test('partially stopped Memory remains stopped in the real list and detail without counting the cancelled input as completed',async t=>{
 const f=await fixture(t),ui=await domFixture(t),ids=await f.memoryStart(),binding=await f.api.request<{revision:number}>('/api/memory-spaces/default/binding');f.control.failReview=false;
 await f.api.request('/api/memory-spaces/default/binding/stop',{method:'POST',body:JSON.stringify({expectedRevision:binding.revision,operationId:randomUUID()})});f.review.release();await f.node.delegation.tick();
 const work=await f.activity(ids.id);assert.equal(work.state,'cancelled',JSON.stringify({state:work.state,progress:work.progress,jobs:f.node.memoryPipeline.list().map(job=>({id:job.id,status:job.status}))}));assert.equal(work.progress.mode==='determinate'&&work.progress.completed,1);assert.equal(work.progress.mode==='determinate'&&work.progress.total,2);assert.ok(work.branches.every(branch=>['completed','cancelled'].includes(branch.state)));
 const page=await f.api.request<{items:WorkActivity[]}>('/api/work-activity?state=completed');assert.equal(page.items.find(item=>item.id===ids.id)!.state,'cancelled');
 await ui.activity(f.api,ids.id);assert.match(ui.d.body.textContent!,/已停止/);assert.match(ui.d.body.textContent!,/已处理 1 \/ 2 条资料/);await f.restart();assert.equal((await f.activity(ids.id)).state,'cancelled');
});

test('mounted capacity settings save only the four writable fields and read their real limits after restart',async t=>{
 const f=await fixture(t),ui=await domFixture(t);await act(async()=>ui.root.render(React.createElement(React.Fragment,null,React.createElement(RuntimeSettings,{api:f.api,kind:'execution'}),React.createElement(ExecutionQueueOverview,{api:f.api}))));
 const inputs=[...ui.d.querySelectorAll<HTMLInputElement>('input[type=number]')];assert.equal(inputs.length,4);
 for(const [index,value] of [2,3,2,1].entries())await act(async()=>{Object.getOwnPropertyDescriptor(ui.d.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(inputs[index],String(value));inputs[index].dispatchEvent(new ui.d.defaultView!.Event('input',{bubbles:true}));});
 await act(async()=>ui.d.querySelector('form')!.dispatchEvent(new ui.d.defaultView!.Event('submit',{bubbles:true,cancelable:true})));
 const write=f.writes.find(item=>item.path==='/api/execution-settings')!;assert.ok(write);assert.deepEqual(Object.keys(write.body as object).sort(),['agentConcurrency','interactiveConcurrency','llmConcurrency','memoryConcurrency','revision']);
 await act(async()=>until(()=>ui.d.querySelector('[role=status]')?.textContent?.includes('已保存')===true));assert.match(ui.d.body.textContent!,/已保存/);assert.doesNotMatch(ui.d.body.textContent!,/委派/);await f.restart();await act(async()=>resources(f.api).invalidate(path=>path==='/api/execution-settings'));
 assert.deepEqual([...ui.d.querySelectorAll<HTMLInputElement>('input[type=number]')].map(input=>input.value),['2','3','2','1']);const view=await f.api.request<{queues:{agents:{limit:number};llm:{limit:number};interactive:{limit:number};delegated:{background:{limit:number};interactive:{limit:number}}}}>('/api/execution-settings');assert.equal(view.queues.agents.limit,3);assert.equal(view.queues.llm.limit,2);assert.equal(view.queues.interactive.limit,2);assert.equal(view.queues.delegated.background.limit,3);assert.equal(view.queues.delegated.interactive.limit,2);
});

test('owner cancellation stops an unresolved input plan in real Activity without losing its known record count',async t=>{
 const f=await fixture(t),ui=await domFixture(t),sourceId='generated-pending-progress',deviceId='generated-pending-device',at='2026-10-01T00:00:00Z';
 await f.api.request('/api/sources',{method:'POST',body:JSON.stringify({id:sourceId,name:'Generated pending input',kind:'custom',deviceId,platform:'import'})});
 const original=await f.api.request<{id:string}>('/api/sources/'+sourceId+'/items',{method:'PUT',body:JSON.stringify({externalId:'original',revision:'1',observedAt:at,kind:'message',layer:'original',text:'Generated original while its derived input is pending.'})});
 const material=f.node.materials.publish({id:materialId(sourceId,'original'),kind:'mote.message',schemaVersion:1,title:'Generated pending interpretation',origin:{sourceId,externalId:'original',deviceId,firstAt:at,lastAt:at},members:[{id:'original',kind:'capture',ref:'capture:'+original.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated original while its derived input is pending.',memberIds:['original']}],artifacts:[{key:'body',state:'ready',blockIds:['body']},{key:'daily-events',state:'pending'}],coverage:{state:'partial'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 const job=await f.api.request<{id:string}>('/api/memory-jobs',{method:'POST',body:JSON.stringify({deviceId,recipes:[{id:'mote.daily-event-memory',version:'2'}]})}),id='memory:'+job.id;
 await until(()=>f.node.memoryPipeline.get(job.id).status==='waiting_for_input');
 const observe=async(cancelled:boolean)=>{
  const current=f.node.memoryPipeline.get(job.id);assert.equal(current.status,cancelled?'cancelled':'waiting_for_input');assert.equal(current.inputPlans?.total,1);assert.equal(current.inputPlans?.completed,0);assert.equal((current.inputPlans?.waiting??0)+(current.inputPlans?.blocked??0),1);assert.equal(current.batches.length,0);assert.equal(f.calls.length,0);
  const plans=f.node.store.db.prepare('SELECT material_id FROM memory_input_plans WHERE job_id=?').all(job.id);assert.deepEqual(plans.map(row=>row.material_id),[material.id]);
  const detail=await f.activity(id),page=await f.api.request<{items:WorkActivity[]}>('/api/work-activity?state='+(cancelled?'completed':'attention')+'&limit=20'),card=page.items.find(item=>item.id===id);assert.ok(card);
  for(const work of [detail,card]){assert.equal(work.state,cancelled?'cancelled':'needs_input');assert.equal(work.progress.mode,'determinate');assert.equal(work.progress.mode==='determinate'&&work.progress.total,1);assert.equal(work.progress.mode==='determinate'&&work.progress.completed,0);}
  assert.deepEqual(card.progress,detail.progress);assert.equal(detail.events.some(event=>event.type==='work.cancelled'),cancelled);
  await ui.activity(f.api,id);await ui.refresh(f.api,id);assert.match(ui.d.body.textContent!,/已处理 0 \/ 1 条资料/);
  const visible=ui.d.querySelector('.activity-current')!.textContent!;if(cancelled){assert.match(visible,/已停止/);assert.doesNotMatch(visible,/等待开始/);}else assert.doesNotMatch(visible,/已停止/);
  if(cancelled)for(const state of ['active','attention'])assert.ok(!(await f.api.request<{items:WorkActivity[]}>('/api/work-activity?state='+state+'&limit=20')).items.some(item=>item.id===id));
 };
 await observe(false);await f.restart();await observe(false);
 const stopped=await f.api.request<{status:string}>('/api/memory-jobs/'+job.id+'/cancel',{method:'POST',body:'{}'});assert.equal(stopped.status,'cancelled');
 await observe(true);await f.restart();await observe(true);
});
