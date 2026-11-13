import '@mote/shared/i18n-all';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {fixtureMemoryResult} from '../../server/test/fixtures/memory-result.js';
import {createApi} from '../src/api.js';
import {Memories} from '../src/plugins/memory/index.js';
import {resources} from '../src/resource-cache.js';

const at='2026-10-01T10:00:00.000Z';
const token='generated-u3-owner';
const headers={authorization:'Bearer '+token};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function settled(predicate:()=>boolean){for(let n=0;n<100;n++){await act(turn);if(predicate())return;}assert.fail('Generated UI did not reach the expected state');}
async function click(d:Document,label:string){await act(async()=>{const button=[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label&&!button.closest('[hidden]'));assert.ok(button,label);assert.equal(button.disabled,false);button.click();});}
async function fill(d:Document,selector:string,value:string){await act(async()=>{const input=d.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!;assert.ok(input,selector);input.focus();const proto=input.tagName==='TEXTAREA'?d.defaultView!.HTMLTextAreaElement.prototype:d.defaultView!.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value);input.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));input.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'n'}));});}

/** Real server serialization -> real Web API parser -> mounted Memory views.
 * Only fetch is adapted to loopback injection; all data lives in a generated,
 * private temporary profile. No provider or user profile is consulted. */
async function fixture(t:TestContext){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-u3-web-'));
  const config:Config={dataDir,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected generated model call');},close:async()=>{}}});
  await node.app.ready();
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/assistant/memory',pretendToBeVisual:true}),d=dom.window.document;
  const prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
  const reads:{path:string;signal?:AbortSignal|null}[]=[];
  let gate:((path:string,value:unknown,signal?:AbortSignal|null)=>Promise<void>)|undefined;
  const fetcher=async(input:unknown,init?:RequestInit)=>{
    const path=String(input);reads.push({path,signal:init?.signal});
    const response=await node.app.inject({url:path,method:(init?.method??'GET') as 'GET'|'POST'|'DELETE',headers:Object.fromEntries(new Headers(init?.headers)),...(init?.body?{payload:String(init.body)}:{})});
    if(gate)await gate(path,response.json(),init?.signal);
    return new Response(response.body,{status:response.statusCode,headers:{'Content-Type':'application/json'}});
  };
  for(const[key,value]of Object.entries({window:dom.window,document:d,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,fetch:fetcher,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
  Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});dom.window.scrollTo=()=>{};
  const root=createRoot(d.getElementById('root')!),api=createApi({token}),opened:string[]=[];
  t.after(async()=>{await act(async()=>root.unmount());await node.app.close();rmSync(dataDir,{recursive:true,force:true});configureLocale(()=>locale);for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
  const add=async(text:string,deviceId='generated-work',title='Alex',extra:Record<string,unknown>={})=>{
    const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId,deviceName:'Generated',platform:'import',capturedAt:at,text}});assert.equal(response.statusCode,201,response.body);
    const raw={answer:JSON.stringify({memories:[{title,statement:`${text} [${id}]`,uncertainty:'Generated evidence only',evidenceIds:[id],...extra}]}),citations:[{id,capturedAt:at,appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()};
    const draft=node.memories.extract(fixtureMemoryResult(node.memories,raw),'generated').items[0]!,memory=node.memories.publish(draft.id,draft.version);
    return {id,text,memory};
  };
  const commitment=(person:Awaited<ReturnType<typeof add>>,title:string,options:{matterId?:string;deadline?:{text:string;at:string|null}}={})=>node.featureServices.assistantCommitments.publish({
    commitmentId:randomUUID(),eventId:randomUUID(),kind:'commitment',occurredAt:null,summary:person.text,
    changes:{title,status:'confirmed',personMemoryId:person.memory.id,...options},evidence:[{id:person.id,offset:0,quote:person.text}],evidenceDependencies:{version:1,complete:true,ids:[person.id]},
  },undefined,{kind:'all'},()=>{});
  const mount=async(range:Record<string,string>={})=>{await act(async()=>root.render(React.createElement(Memories,{api,range,onOpen:ref=>opened.push(ref)})));await settled(()=>Boolean(d.querySelector('.workspace-select'))||d.body.textContent!.includes('当前筛选下没有匹配'));};
  return {node,root,d,api,reads,opened,add,commitment,mount,setGate:(value:typeof gate)=>{gate=value;}};
}

test('real A15 and A7 outputs keep same-name people separate and allow several matters without inventing a goal or deadline',async t=>{
  const f=await fixture(t),a=await f.add('Generated studio Alex will send a plan.'),b=await f.add('Generated hiking Alex will bring a map.','generated-life');
  const matter=()=>f.node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated matter',scope:{kind:'all'}},{currentEvidence:()=>[],currentTask:()=>undefined});
  f.commitment(a,'Generated studio promise',{matterId:matter().id,deadline:{text:'sometime soon',at:null}});f.commitment(a,'Generated second promise',{matterId:matter().id});f.commitment(b,'Generated hiking promise');
  await f.mount();await click(f.d,'人物');await settled(()=>f.d.querySelectorAll('[data-person-memory]').length===2);
  assert.deepEqual(new Set([...f.d.querySelectorAll<HTMLElement>('[data-person-memory]')].map(row=>row.dataset.personMemory)),new Set([a.memory.id,b.memory.id]));
  assert.equal([...f.d.querySelectorAll('[data-person-memory] strong')].filter(node=>node.textContent==='Alex').length,2);
  assert.match(f.d.querySelector(`[data-person-memory="${a.memory.id}"]`)!.textContent!,/关联 2 个事项/);
  await act(async()=>f.d.querySelector<HTMLButtonElement>(`[data-person-memory="${a.memory.id}"]`)!.click());await settled(()=>f.d.querySelectorAll('[data-commitment]').length===2);
  const detail=f.d.querySelector('.memory-detail')!;assert.match(detail.textContent!,/Generated studio promise/);assert.match(detail.textContent!,/期限未明确/);assert.doesNotMatch(detail.textContent!,/Generated hiking promise|暂停|目标/);
  assert.match(detail.textContent!,/This generated fixture only/,'the saved applicability is visible');
  await act(async()=>f.d.querySelector<HTMLButtonElement>(`[data-person-memory="${b.memory.id}"]`)!.click());await settled(()=>f.d.querySelectorAll('[data-commitment]').length===1);
  assert.match(f.d.querySelector('.memory-associations')!.textContent!,/Generated hiking promise/);assert.doesNotMatch(f.d.querySelector('.memory-associations')!.textContent!,/Generated studio|期限未明确/);
});

test('the actual scoped Memory browser hides private topic labels, person counts and commitments before display',async t=>{
  const f=await fixture(t),a=await f.add('Generated work Alex.'),b=await f.add('GENERATED_PRIVATE_PERSON_BODY','generated-life','GENERATED_PRIVATE_PERSON');
  f.commitment(a,'Generated allowed promise');f.commitment(b,'GENERATED_PRIVATE_COMMITMENT');
  const dispose=f.node.featureServices.contextTrees.register({id:'generated.private',version:'1',label:'GENERATED_PRIVATE_TOPIC',nodes:[{id:'private',label:'GENERATED_PRIVATE_NODE',select:{memoryIds:[b.memory.id]}}]});t.after(dispose);
  await f.mount({deviceId:'generated-work'});await click(f.d,'主题');await settled(()=>Boolean(f.d.querySelector('.memory-topic-nodes')));
  assert.doesNotMatch(f.d.body.textContent!,/GENERATED_PRIVATE/);
  assert.ok(f.reads.some(read=>read.path==='/api/context-trees?deviceId=generated-work'),'the real catalog receives the current scope');
  await click(f.d,'个人');await settled(()=>f.reads.some(read=>read.path.includes('/api/context-trees/topics/nodes/personal?')));
  assert.ok(f.reads.filter(read=>read.path.includes('/nodes/')).every(read=>new URLSearchParams(read.path.split('?')[1]).get('deviceId')==='generated-work'),'a work/life browsing filter never widens source permission');
  await click(f.d,'人物');await settled(()=>f.d.querySelectorAll('[data-person-memory]').length===1);
  assert.equal(f.d.querySelector<HTMLElement>('[data-person-memory]')!.dataset.personMemory,a.memory.id);assert.doesNotMatch(f.d.body.textContent!,/GENERATED_PRIVATE/);assert.match(f.d.querySelector('.memory-people')!.textContent!,/本页 1 条承诺/);
  for(const scope of [{kind:'selection',sourceIds:[]},{kind:'selection',evidenceIds:[]}]){
    const page=await f.api.request<{items:unknown[];nextCursor:null}>('/api/assistant/commitments?'+new URLSearchParams({scope:JSON.stringify(scope)}));assert.deepEqual(page,{items:[],nextCursor:null});
  }
});

test('owner correction through the existing Memory form changes the person aggregate without new files or onboarding',async t=>{
  const f=await fixture(t),a=await f.add('Generated original association.');f.commitment(a,'Generated obsolete promise');
  await f.mount();await click(f.d,'人物');await settled(()=>Boolean(f.d.querySelector('[data-person-memory]')));await act(async()=>f.d.querySelector<HTMLButtonElement>('[data-person-memory]')!.click());await settled(()=>Boolean(f.d.querySelector('[data-commitment]')));
  await click(f.d,'更多');await click(f.d,'纠正这条记忆');await fill(f.d,'.memory-correction input','Alex corrected');await fill(f.d,'.memory-correction textarea','Generated owner corrected the association.');await click(f.d,'保存纠正');
  await settled(()=>f.d.querySelector('.memory-detail-heading h2')?.textContent==='Alex corrected');
  assert.match(f.d.querySelector('.memory-detail')!.textContent!,/用户纠正/);assert.doesNotMatch(f.d.body.textContent!,/Generated obsolete promise/);assert.equal(f.d.querySelectorAll('[data-person-memory]').length,0);
  const current=f.node.memories.get(a.memory.id).supersededBy!;assert.ok(current);assert.equal(f.node.featureServices.assistantCommitments.page({scope:{kind:'all'}}).items.length,0);
  assert.match(f.d.querySelector('.memory-detail')!.textContent!,/原始说明已保留/);
  const correction=f.node.memories.get(current);assert.equal(f.node.store.evidence([correction.correction!.noteId])[0].ocrText,'Generated owner corrected the association.');
});

test('forgetting retires warm caches and an already serialized late people response cannot resurrect a deleted identity',async t=>{
  const f=await fixture(t),a=await f.add('Generated forgotten person.');f.commitment(a,'Generated forgotten promise');
  await f.mount();await click(f.d,'主题');await settled(()=>Boolean(f.d.querySelector('.memory-topic-nodes')));await click(f.d,'人物');await settled(()=>Boolean(f.d.querySelector('[data-person-memory]')));
  await act(async()=>f.d.querySelector<HTMLButtonElement>('[data-person-memory]')!.click());await settled(()=>Boolean(f.d.querySelector('[data-commitment]')));
  const path=f.reads.find(read=>read.path.startsWith('/api/assistant/commitments?')&&!read.path.includes('personMemoryId'))!.path;
  let release!:()=>void,signal:AbortSignal|null|undefined,held=false;
  f.setGate(async(url,value,currentSignal)=>{if(url!==path||held)return;assert.ok(JSON.stringify(value).includes(a.memory.id),'the delayed response really contains the soon-forgotten identity');held=true;signal=currentSignal;await new Promise<void>(done=>release=done);});t.after(()=>release?.());
  await act(async()=>resources(f.api).get(path).refresh());await settled(()=>held);
  await click(f.d,'更多');await click(f.d,'删除记忆');await click(f.d,'确认删除');await settled(()=>f.d.body.textContent!.includes('记忆已禁止使用'));
  assert.equal(signal?.aborted,true,'the pre-forget generation is cancelled');assert.equal(resources(f.api).get('/api/context-trees').getSnapshot().data,undefined,'unmounted topic labels are retired too');
  await settled(()=>f.d.querySelector('[data-person-memory]')===null);await act(async()=>release());await act(turn);
  assert.equal(f.d.querySelector('[data-person-memory]'),null);assert.doesNotMatch(f.d.body.textContent!,/Generated forgotten/);
  await click(f.d,'全部记忆');await settled(()=>!f.d.querySelector('.workspace-select'));assert.match(f.d.body.textContent!,/当前筛选下没有匹配的记忆/);
});

test('existing Memory shows inference, validity and truthful empty associations without an initial acquaintance run',async t=>{
  const f=await fixture(t),a=await f.add('Generated scoped inference.','generated-work','Generated inference',{validFrom:'2000-01-01T00:00:00.000Z',validUntil:new Date(Date.now()+86400000).toISOString(),admission:{layer:'memory',reason:'Generated inference',scope:'Generated current applicability',attribution:'inferred'}});
  await f.mount();await act(async()=>f.d.querySelector<HTMLButtonElement>('.workspace-select')!.click());await settled(()=>f.d.body.textContent!.includes('当前范围内暂无关联的承诺或互动'));
  const detail=f.d.querySelector('.memory-detail')!;assert.match(detail.textContent!,/推断/);assert.match(detail.textContent!,/生效于/);assert.match(detail.textContent!,/失效于/);assert.match(detail.textContent!,/Generated current applicability/);assert.match(detail.textContent!,/Generated scoped inference/);
  assert.equal(f.d.querySelectorAll('[data-commitment]').length,0);assert.ok(f.reads.some(read=>read.path.includes('personMemoryId='+a.memory.id)));
});

test('opening interaction evidence rechecks the real scoped projection after withdrawal',async t=>{
  const f=await fixture(t),a=await f.add('Generated withdrawn interaction.');f.commitment(a,'Generated withdrawn promise');
  await f.mount();await act(async()=>f.d.querySelector<HTMLButtonElement>('.workspace-select')!.click());await settled(()=>Boolean(f.d.querySelector('[data-commitment]')));
  const proof=f.d.querySelector<HTMLButtonElement>('[data-commitment] details button')!;assert.ok(proof);
  f.node.store.delete(a.id);
  await act(async()=>proof.click());await settled(()=>!f.d.querySelector('[data-commitment]'));
  assert.deepEqual(f.opened,[],'withdrawn proof cannot open from a retained interaction');assert.doesNotMatch(f.d.body.textContent!,/Generated withdrawn/);
});

test('a topic combines explicit Memory references across people and matters without including unrelated commitments',async t=>{
  const f=await fixture(t),a=await f.add('Generated topic studio member.'),b=await f.add('Generated topic hiking member.','generated-life'),c=await f.add('Generated unrelated member.');
  const matter=()=>f.node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated topic matter',scope:{kind:'all'}},{currentEvidence:()=>[],currentTask:()=>undefined});
  f.commitment(a,'Generated topic first promise',{matterId:matter().id});f.commitment(b,'Generated topic second promise',{matterId:matter().id});f.commitment(c,'GENERATED_UNRELATED_PROMISE');
  const dispose=f.node.featureServices.contextTrees.register({id:'generated.shared',version:'1',label:'Generated dimension',nodes:[
    {id:'shared',label:'Generated shared topic',select:{memoryIds:[a.memory.id,b.memory.id]}},
    {id:'empty',label:'Generated empty topic',select:{memoryIds:[]}},
  ]});t.after(dispose);
  await f.mount();await click(f.d,'主题');await settled(()=>Boolean(f.d.querySelector('.memory-dimension select')));
  await act(async()=>{const select=f.d.querySelector<HTMLSelectElement>('.memory-dimension select')!;select.value='generated.shared';select.dispatchEvent(new f.d.defaultView!.Event('change',{bubbles:true}));});
  await click(f.d,'Generated shared topic');await settled(()=>f.d.querySelectorAll('.memory-associations [data-commitment]').length===2);
  const topic=f.d.querySelector('.memory-associations')!;assert.match(topic.textContent!,/Generated topic first promise/);assert.match(topic.textContent!,/Generated topic second promise/);assert.match(topic.textContent!,/关联 2 个事项/);assert.match(topic.textContent!,/仅汇总本页记忆与本页承诺/);assert.doesNotMatch(topic.textContent!,/GENERATED_UNRELATED/);
  await click(f.d,'Generated empty topic');await settled(()=>Boolean(f.d.querySelector('.memory-associations')?.textContent?.includes('本页暂无关联的承诺或互动')));
  assert.match(f.d.querySelector('.memory-associations')!.textContent!,/本页暂无关联的承诺或互动/);assert.doesNotMatch(f.d.querySelector('.memory-associations')!.textContent!,/Generated topic first promise|Generated topic second promise/);
});

test('an unavailable person Memory shows a retry instead of an unexplained empty aggregate',async t=>{
  const f=await fixture(t),a=await f.add('Generated retryable person.');f.commitment(a,'Generated retryable promise');let unavailable=true;
  f.setGate(async path=>{if(unavailable&&path.startsWith('/api/memories/'+a.memory.id+'?'))throw Error('Generated unavailable person');});
  await f.mount();await click(f.d,'人物');await settled(()=>Boolean(f.d.querySelector('.memory-people [role=alert]')));
  assert.equal(f.d.querySelector('[data-person-memory]'),null);assert.doesNotMatch(f.d.querySelector('.memory-people')!.textContent!,/本页暂无已关联的人物/);
  unavailable=false;await click(f.d,'重新读取');await settled(()=>Boolean(f.d.querySelector('[data-person-memory]')));assert.equal(f.d.querySelector('.memory-people [role=alert]'),null);
});
