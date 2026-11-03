import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {WorkActivity} from '@mote/shared';
import {Activity} from '../src/plugins/work/Activity.js';
import {QueryProgress} from '../src/plugins/ask/QueryProgress.js';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:import('node:test').TestContext){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/activity',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}dom.window.scrollTo=()=>{};const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};}
const disclosure=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLElement>('summary')).find(value=>value.childNodes[0]?.textContent===label)!;
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent?.trim()===label||button.getAttribute('aria-label')===label)!;
const generated:WorkActivity={id:'memory-source:fixture',kind:'memory',goal:'整理合成日记',state:'running',createdAt:'2026-09-20T01:00:00Z',updatedAt:'2026-09-20T01:01:00Z',progress:{mode:'determinate',unit:'records',total:4,completed:1,failed:0,needsInput:0,excluded:0},branchCounts:{total:2,running:1,completed:1},branches:[{id:'one',title:'核对合成经历',state:'completed',artifactIds:['memory-one']},{id:'two',title:'检查合成时间线',state:'running',artifactIds:[]}],artifacts:[{id:'memory-one',kind:'memory',title:'已保存 1 条记忆',count:1}],evidence:{count:1,refs:['00000000-0000-4000-8000-000000000001','memory:00000000-0000-4000-8000-000000000002'],runId:'generated-run'},events:[{id:'event',type:'branch.completed',at:'2026-09-20T01:01:00Z',summary:'合成经历已核对'}],destination:'memories',technical:{operationIds:['memory:generated-job'],runId:'generated-run'}};
test('Activity progressively opens goal, host branches, results, evidence and advanced execution',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[],open:string[]=[],navigation:string[]=[];let completed=1;
 const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});if(path.includes('/memory-results'))return {ids:['00000000-0000-4000-8000-000000000002'],total:1,nextCursor:null};if(path.startsWith('/api/memories/'))return {id:'00000000-0000-4000-8000-000000000002',title:'合成记忆',status:'published',createdAt:'2026-09-20T01:00:00Z'};if(path.startsWith('/api/work-activity/'))return {...generated,progress:{...generated.progress,completed}};return {items:path.includes('state=attention')?[]:[{...generated,branches:[],events:[],evidence:{count:1,refs:[]}}],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Activity,{api,onNavigate:page=>navigation.push(page),onOpen:ref=>open.push(ref)})));
 assert.equal(d.querySelector('h1')!.textContent,'后台活动');assert.match(d.body.textContent!,/已处理 1 \/ 4 条资料/);assert(!d.body.textContent!.includes('memory:generated-job'));assert(!reads.some(path=>path.startsWith('/api/operations?')));
 await act(async()=>d.querySelector<HTMLButtonElement>('.activity-card')!.click());assert.equal(d.querySelector('h1')!.textContent,'整理合成日记');assert.match(d.body.textContent!,/合成经历已核对/);
 await act(async()=>disclosure(d,'工作分支').click());assert.match(d.body.textContent!,/核对合成经历/);assert.match(d.body.textContent!,/检查合成时间线/);
 completed=4;await act(async()=>resources(api).get('/api/work-activity/memory-source%3Afixture?limit=20').refresh());assert.match(d.body.textContent!,/已处理 4 \/ 4 条资料/);assert.equal(d.querySelector('progress')!.value,4);
 assert.equal(d.querySelector('nav[aria-label=工作详情]'),null);assert.match(d.body.textContent!,/合成记忆/);assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,1);
 await act(async()=>disclosure(d,'原始依据').click());await act(async()=>button(d,'来源资料 1').click());assert.deepEqual(open,['capture:00000000-0000-4000-8000-000000000001']);await act(async()=>button(d,'来源资料 2').click());assert.equal(open[1],'memory:00000000-0000-4000-8000-000000000002');await act(async()=>button(d,'查看 Agent 实际输入').click());assert.equal(navigation.at(-1),'agentView');assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('runId'),'generated-run');
 // Restore work after exercising the actual inspector navigation.
 await act(async()=>{location.hash='#/activity?work=memory-source%3Afixture';window.dispatchEvent(new d.defaultView!.Event('hashchange'));});
 await act(async()=>disclosure(d,'运行信息').click());assert.match(d.body.textContent!,/memory:generated-job/);await act(async()=>button(d,'技术执行记录').click());assert.equal(navigation.at(-1),'processing');
 await act(async()=>button(d,'返回活动').click());await act(async()=>button(d,'需要处理').click());assert.match(d.body.textContent!,/目前没有需要处理的工作/);
});
test('open-ended Ask shows public stage and host counts without inventing a percentage or opening raw logs',async t=>{
 const {root,d}=await fixture(t);await act(async()=>root.render(React.createElement(QueryProgress,{run:{id:'fixture',status:'running',createdAt:'2026-09-20T01:00:00Z',updatedAt:'2026-09-20T01:01:00Z',events:[{stage:'tool',phase:'completed',tool:'evidence',count:3,at:'2026-09-20T01:00:10Z'},{stage:'validating',at:'2026-09-20T01:00:20Z'}]},error:''})));
 assert.match(d.body.textContent!,/交叉核对/);assert.match(d.body.textContent!,/检索已返回 3 项资料/);assert.equal(d.querySelectorAll('progress').length,0);assert.equal(d.querySelector('details')!.open,false);assert.doesNotMatch(d.body.textContent!,/\d+%/);
});

test('related activity uses exact identities and describes incomplete coverage even when no linked work is found',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});return {items:[],nextCursor:path.includes('sourceId=')?8:null,relation:{coverage:'partial',sourceId:'generated/source'}};},setAgentTimeout:()=>{}} as Api;
 location.hash='#/activity?sourceId=generated%2Fsource';
 await act(async()=>root.render(React.createElement(Activity,{api,onNavigate:()=>{},onOpen:()=>{}})));
 assert.ok(reads.some(path=>path.includes('sourceId=generated%2Fsource')));assert.match(d.body.textContent!,/未找到已关联活动/);assert.match(d.body.textContent!,/历史关联可能不完整/);assert.doesNotMatch(d.body.textContent!,/目前没有正在进行的工作/);
 await act(async()=>button(d,'下一页').click());assert.ok(reads.some(path=>path.includes('cursor=8')));
 await act(async()=>{location.hash='#/activity?materialId=mat_generated';window.dispatchEvent(new d.defaultView!.Event('hashchange'));});
 assert.ok(reads.some(path=>path.includes('materialId=mat_generated')&&!path.includes('sourceId=')),'same-page filter changes update the actual read scope');
 assert.ok(reads.filter(path=>path.includes('materialId=')).every(path=>!path.includes('cursor=')),'a cursor from another relation is never sent to the new scope');assert.match(d.querySelector('.list-pagination')!.textContent!,/第 1 页/);
 assert.equal(d.querySelector<HTMLAnchorElement>('.related-activity-context a')!.getAttribute('href'),'#/activity');
});

test('an Activity result preserves the original scroll across page navigation without leaking it to another activity or owner',async t=>{
 const{root,d}=await fixture(t),w=d.defaultView!;let y=0;Object.defineProperty(w,'scrollY',{configurable:true,get:()=>y});w.scrollTo=((first:ScrollToOptions|number,second?:number)=>{y=typeof first==='number'?second??0:first.top??0;}) as typeof w.scrollTo;
 const value=(id:string):WorkActivity=>({...generated,id,goal:'Generated activity '+id});
 const makeApi=()=>({request:async(path:string)=>path.startsWith('/api/operations/changes')?new Promise(()=>{}):path.includes('/memory-results')?{ids:[],total:0,nextCursor:null}:path.startsWith('/api/work-activity/')?value(decodeURIComponent(path.split('/').at(-1)!.split('?')[0])):{items:[],nextCursor:null},setAgentTimeout:()=>{}} as Api),owner=makeApi(),anotherOwner=makeApi();
 const render=(api:Api)=>act(async()=>root.render(React.createElement(Activity,{api,onOpen:()=>{},onNavigate:()=>{w.location.hash='#/library?view=memories';y=0;}})));
 w.location.hash='#/activity?work=memory%3Aone';await render(owner);assert.match(d.querySelector('.activity-detail h1')!.textContent!,/memory:one/);
 y=267;await act(async()=>w.dispatchEvent(new w.Event('scroll')));await act(async()=>button(d,'打开相关资料与操作').click());await act(async()=>root.render(null));
 w.location.hash='#/activity?work=memory%3Aone';await render(owner);assert.equal(y,267,'return to the same activity restores its last actual scroll');
 await act(async()=>root.render(null));y=0;w.location.hash='#/activity?work=memory%3Atwo';await render(owner);assert.equal(y,0,'a different activity starts at its own position');
 await act(async()=>root.render(null));y=0;w.location.hash='#/activity?work=memory%3Aone';await render(anotherOwner);assert.equal(y,0,'another owner never inherits the previous owner position');
});
