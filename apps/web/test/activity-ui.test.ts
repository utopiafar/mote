import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {WorkActivity} from '@mote/shared';
import {Activity} from '../src/Activity.js';
import {QueryProgress} from '../src/QueryProgress.js';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:import('node:test').TestContext){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/activity',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent?.trim()===label)!;
const generated:WorkActivity={id:'memory-source:fixture',kind:'memory',goal:'整理合成日记',state:'running',createdAt:'2026-09-20T01:00:00Z',updatedAt:'2026-09-20T01:01:00Z',progress:{mode:'determinate',unit:'records',total:4,completed:1,failed:0,needsInput:0,excluded:0},branchCounts:{total:2,running:1,completed:1},branches:[{id:'one',title:'核对合成经历',state:'completed',artifactIds:['memory-one']},{id:'two',title:'检查合成时间线',state:'running',artifactIds:[]}],artifacts:[{id:'memory-one',kind:'memory',title:'已保存 1 条记忆',count:1}],evidence:{count:1,refs:['00000000-0000-4000-8000-000000000001','memory:00000000-0000-4000-8000-000000000002'],runId:'generated-run'},events:[{id:'event',type:'branch.completed',at:'2026-09-20T01:01:00Z',summary:'合成经历已核对'}],destination:'memories',technical:{operationIds:['memory:generated-job'],runId:'generated-run'}};
test('Activity progressively opens goal, host branches, results, evidence and advanced execution',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[],open:string[]=[],navigation:string[]=[];let completed=1;
 const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});if(path.startsWith('/api/work-activity/'))return {...generated,progress:{...generated.progress,completed}};return {items:path.includes('state=attention')?[]:[{...generated,branches:[],events:[],evidence:{count:1,refs:[]}}],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Activity,{api,onNavigate:page=>navigation.push(page),onOpen:ref=>open.push(ref)})));
 assert.equal(d.querySelector('h1')!.textContent,'活动');assert.match(d.body.textContent!,/已处理 1 \/ 4 条资料/);assert(!d.body.textContent!.includes('memory:generated-job'));assert(!reads.some(path=>path.startsWith('/api/operations?')));
 await act(async()=>d.querySelector<HTMLButtonElement>('.activity-card')!.click());assert.equal(d.querySelector('h1')!.textContent,'整理合成日记');assert.match(d.body.textContent!,/合成经历已核对/);
 await act(async()=>button(d,'工作分支').click());assert.match(d.body.textContent!,/核对合成经历/);assert.match(d.body.textContent!,/检查合成时间线/);
 completed=4;await act(async()=>resources(api).get('/api/work-activity/memory-source%3Afixture?limit=20').refresh());assert.match(d.body.textContent!,/已处理 4 \/ 4 条资料/);assert.equal(d.querySelector('progress')!.value,4);
 await act(async()=>button(d,'成果').click());assert.match(d.body.textContent!,/已保存 1 条记忆/);await act(async()=>button(d,'查看成果').click());assert.deepEqual(navigation,['memories']);
 await act(async()=>button(d,'证据').click());await act(async()=>button(d,'来源资料 1').click());assert.deepEqual(open,['capture:00000000-0000-4000-8000-000000000001']);await act(async()=>button(d,'来源资料 2').click());assert.equal(open[1],'memory:00000000-0000-4000-8000-000000000002');await act(async()=>button(d,'查看 Agent 实际输入').click());assert.equal(navigation.at(-1),'agentView');assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('runId'),'generated-run');
 // Restore work after exercising the actual inspector navigation.
 await act(async()=>{location.hash='#/activity?work=memory-source%3Afixture';window.dispatchEvent(new d.defaultView!.Event('hashchange'));});
 await act(async()=>button(d,'技术详情').click());assert.match(d.body.textContent!,/memory:generated-job/);await act(async()=>button(d,'技术执行记录').click());assert.equal(navigation.at(-1),'processing');
 await act(async()=>button(d,'返回活动').click());await act(async()=>button(d,'需要处理').click());assert.match(d.body.textContent!,/目前没有需要处理的工作/);
});
test('open-ended Ask shows public stage and host counts without inventing a percentage or opening raw logs',async t=>{
 const {root,d}=await fixture(t);await act(async()=>root.render(React.createElement(QueryProgress,{run:{id:'fixture',status:'running',createdAt:'2026-09-20T01:00:00Z',updatedAt:'2026-09-20T01:01:00Z',events:[{stage:'tool',phase:'completed',tool:'evidence',count:3,at:'2026-09-20T01:00:10Z'},{stage:'validating',at:'2026-09-20T01:00:20Z'}]},error:''})));
 assert.match(d.body.textContent!,/交叉核对/);assert.match(d.body.textContent!,/检索已返回 3 项资料/);assert.equal(d.querySelectorAll('progress').length,0);assert.equal(d.querySelector('details')!.open,false);assert.doesNotMatch(d.body.textContent!,/\d+%/);
});
