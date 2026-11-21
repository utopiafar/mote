import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {randomUUID} from 'node:crypto';
import type {GoalGroup,GoalItem,GoalsView,Matter,QueryScope} from '@mote/shared';
import {ApiError,type Api} from '../src/api';
import {GoalsPage} from '../src/plugins/assistant/GoalsPage';
import {AssistantWorkbenchPage,workbenchMatterTarget} from '../src/plugins/assistant-workbench';

const all:QueryScope={kind:'all'};
const at='2026-11-20T02:00:00Z';
const ids={
  release:'11111111-1111-4111-8111-111111111111',
  review:'22222222-2222-4222-8222-222222222222',
  home:'33333333-3333-4333-8333-333333333333',
  alice:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bob:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  carol:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  todo:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  evidence:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};
type Row={item:GoalItem;matterId?:string;person?:string};
type Call={path:string;method:string;body?:Record<string,unknown>};
type State={matters:Matter[];rows:Row[];sequence:number};
const matter=(id:string,goal:string,evidenceIds:string[]=[]):Matter=>({id,goal,scope:all,state:'active',revision:1,taskIds:[],evidenceIds,correction:null,createdAt:at,updatedAt:at,archivedAt:null});
const base=():State=>({
  matters:[matter(ids.release,'Generated release',[ids.evidence,ids.alice,ids.bob]),matter(ids.review,'Generated review',[ids.evidence]),matter(ids.home,'Generated home')],
  sequence:0,
  rows:[
    {matterId:ids.release,person:'Generated Alice',item:{id:ids.alice,kind:'commitment',title:'Generated sidebar copy',direction:'theirs',due:{text:'Generated Friday',at:null},lastProgress:{summary:'Generated review note',at,evidenceId:ids.evidence},followup:{followed:false},inferred:false,revision:3,actions:['complete','dismiss','follow']}},
    {matterId:ids.review,person:'Generated Bob',item:{id:ids.bob,kind:'commitment',title:'Generated merge repair',direction:'mine',due:{text:'Generated tomorrow',at:null},followup:{followed:true},inferred:false,revision:4,actions:['complete','dismiss']}},
    {matterId:ids.release,person:'Generated Alice',item:{id:ids.carol,kind:'commitment',title:'Generated announcement',direction:'theirs',inferred:true,revision:5,actions:['reject']}},
    {item:{id:ids.todo,kind:'todo',title:'Generated family dinner',direction:'mine',due:{text:'Generated Saturday',at:null},inferred:false,revision:6,actions:['complete','dismiss']}},
  ],
});
function view(state:State,grouping:'matter'|'person'):GoalsView{
  const groups=new Map<string,GoalGroup>();
  const ensure=(key:GoalGroup['key'])=>{
    const id=key.kind==='matter'?'matter:'+key.id:key.kind==='person'?'person:'+key.name:'none';
    const current=groups.get(id);if(current)return current;
    const group={key,theirs:[],mine:[],unconfirmed:[]} as GoalGroup;groups.set(id,group);return group;
  };
  if(grouping==='matter')for(const item of state.matters)ensure({kind:'matter',id:item.id,title:item.goal});
  for(const row of state.rows){
    let key:GoalGroup['key']={kind:'none'};
    if(grouping==='matter'&&row.matterId){const owner=state.matters.find(item=>item.id===row.matterId);if(owner)key={kind:'matter',id:owner.id,title:owner.goal};}
    else if(grouping==='person'&&row.person)key={kind:'person',name:row.person};
    const group=ensure(key),section=row.item.inferred?'unconfirmed':row.item.direction==='theirs'?'theirs':'mine';
    group[section].push(structuredClone(row.item));
  }
  const ordered=[...groups.values()].filter(group=>group.theirs.length||group.mine.length||group.unconfirmed.length||group.key.kind==='matter');
  const rank=(group:GoalGroup)=>group.key.kind==='matter'?0:group.key.kind==='person'?1:2;
  ordered.sort((left,right)=>rank(left)-rank(right)||JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)));
  return {revision:'generated-goals-'+grouping+'-'+state.sequence,groups:ordered};
}
function fixture(t:import('node:test').TestContext,initial=base()){
  configureLocale(()=> 'zh-CN');
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/goals',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{},scrollIntoView:()=>{}});dom.window.scrollTo=()=>{};dom.window.confirm=()=>true;
  const state=initial,calls:Call[]=[],opened:string[]=[],d=dom.window.document,root=createRoot(d.getElementById('root')!);
  const api={request:async(path:string,init?:RequestInit)=>{
    const method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;
    calls.push({path,method,...(body?{body}:{})});
    if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[
      {id:'http:GET:/api/assistant/goals',version:'1',surface:'data',state:'active',featureId:'mote.assistant'},
      {id:'http:POST:/api/assistant/goals',version:'1',surface:'command',state:'active',featureId:'mote.assistant'},
      {id:'http:GET:/api/assistant/matters',version:'1',surface:'data',state:'active',featureId:'mote.assistant'},
      {id:'http:POST:/api/assistant/matter-commands',version:'1',surface:'command',state:'active',featureId:'mote.assistant'},
    ]};
    if(method==='GET'&&path.startsWith('/api/assistant/goals?')){
      const group=new URLSearchParams(path.split('?')[1]).get('group')==='person'?'person':'matter';
      return view(state,group);
    }
    if(method==='GET'&&path.startsWith('/api/assistant/matters?'))return {items:structuredClone(state.matters),nextCursor:null};
    if(method==='POST'&&path==='/api/assistant/goals'){
      const id=randomUUID();
      state.sequence++;
      state.rows.push({item:{id,kind:'todo',title:String(body!.title),direction:'mine',...(body!.due?{due:body!.due as GoalItem['due']}:{}),inferred:false,revision:1,actions:['complete','dismiss']}});
      return {id,kind:'todo',revision:1};
    }
    if(method==='POST'&&/^\/api\/assistant\/goals\/[^/]+\/follow$/.test(path)){
      const row=state.rows.find(item=>item.item.id===path.split('/')[4]);
      if(!row)throw new ApiError('Generated missing goal',404);
      if(row.item.revision!==body!.expectedRevision)throw new ApiError('Generated changed goal',409);
      row.item.followup={followed:true};row.item.actions=row.item.actions.filter(action=>action!=='follow');state.sequence++;
      return {followed:true,routineId:ids.review};
    }
    if(method==='POST'&&/^\/api\/assistant\/goals\/[^/]+\/action$/.test(path)){
      const id=path.split('/')[4],index=state.rows.findIndex(item=>item.item.id===id),row=state.rows[index];
      if(!row)throw new ApiError('Generated missing goal',404);
      if(row.item.revision!==body!.expectedRevision)throw new ApiError('Generated changed goal',409);
      if(body!.action==='reject'&&!row.item.inferred)throw new ApiError('Generated unchanged goal',409);
      state.rows.splice(index,1);state.sequence++;
      return {id,kind:row.item.kind,revision:Number(body!.expectedRevision)+1,status:body!.action==='complete'?'completed':'cancelled'};
    }
    if(method==='POST'&&path==='/api/assistant/matter-commands'){
      const owner=state.matters.find(item=>item.id===body!.matterId);
      if(!owner)throw new ApiError('Generated missing matter',404);
      if(owner.revision!==body!.expectedRevision)throw new ApiError('Generated changed matter',409);
      if(body!.type==='edit'){owner.goal=String(body!.goal);owner.revision++;}
      else{state.matters=state.matters.filter(item=>item!==owner);}
      state.sequence++;
      return owner;
    }
    throw new ApiError('Generated unexpected request '+method+' '+path,404);
  }} as Api;
  const render=async(ready=()=>Boolean(d.querySelector('.goals-group,.goals-empty')))=>{
    await act(async()=>root.render(React.createElement(GoalsPage,{api,onOpen:ref=>opened.push(ref)})));
    await settle(()=>ready());
  };
  const settle=async(predicate:()=>boolean)=>{const end=Date.now()+10000;while(!predicate()&&Date.now()<end)await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});assert.ok(predicate(),'the generated response reaches its mounted consumer');};
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
  return {api,state,calls,opened,d,render,settle};
}
async function click(d:Document,label:string){
  await act(async()=>{const button=[...d.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(button,label);button.click();});
}
async function clickIn(parent:ParentNode,label:string){
  await act(async()=>{const button=[...parent.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(button,label);button.click();});
}
async function clickAria(d:Document,label:string){
  await act(async()=>{const button=d.querySelector<HTMLButtonElement>('button[aria-label="'+label+'"]');assert.ok(button,label);button.click();});
}
async function input(d:Document,selector:string,value:string){
  await act(async()=>{const area=d.querySelector<HTMLTextAreaElement|HTMLInputElement>(selector);assert.ok(area,selector);area.focus();Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area),'value')!.set!.call(area,value);area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});
}
const group=(d:Document,id:string)=>d.querySelector<HTMLElement>('.goals-group[data-group="'+id+'"]');

test('GO2-01 switching to people renders one card per person',async t=>{
  const ui=await fixture(t);await ui.render();
  assert.equal(ui.d.querySelectorAll('.goals-group').length,3);
  assert.ok(group(ui.d,'matter:'+ids.release));assert.ok(group(ui.d,'matter:'+ids.review));assert.ok(group(ui.d,'none'));
  await click(ui.d,'人');
  await ui.settle(()=>Boolean(group(ui.d,'person:Generated Alice'))&&Boolean(group(ui.d,'person:Generated Bob')));
  assert.ok(group(ui.d,'person:Generated Alice'));assert.ok(group(ui.d,'person:Generated Bob'));
  assert.match(group(ui.d,'person:Generated Alice')!.textContent!,/Generated sidebar copy/);
  assert.match(group(ui.d,'person:Generated Bob')!.textContent!,/Generated merge repair/);
  assert.equal(group(ui.d,'matter:'+ids.release),null);
});

test('GO2-02 rejecting an inferred item removes it from the page',async t=>{
  const ui=await fixture(t);await ui.render();
  assert.match(group(ui.d,'matter:'+ids.release)!.textContent!,/Generated announcement/);
  await act(async()=>{ui.d.querySelector<HTMLButtonElement>('.goals-inferred')!.click();});
  await ui.settle(()=>!ui.d.body.textContent!.includes('Generated announcement'));
  const call=ui.calls.find(item=>item.method==='POST'&&item.path.endsWith('/action'))!;
  assert.deepEqual(call.body,{kind:'commitment',action:'reject',expectedRevision:5});
  assert.equal(ui.state.rows.some(row=>row.item.id===ids.carol),false);
});

test('GO2-03 following a commitment turns the suggestion into Mote is watching',async t=>{
  const ui=await fixture(t);await ui.render();
  const card=group(ui.d,'matter:'+ids.release)!;
  assert.match(card.textContent!,/交给 Mote 盯着/);
  await click(card,'照做');
  await ui.settle(()=>group(ui.d,'matter:'+ids.release)!.textContent!.includes('已交给 Mote'));
  assert.doesNotMatch(group(ui.d,'matter:'+ids.release)!.textContent!,/照做/);
  const call=ui.calls.find(item=>item.method==='POST'&&item.path.endsWith('/follow'))!;
  assert.equal(call.path,'/api/assistant/goals/'+ids.alice+'/follow');assert.deepEqual(call.body,{expectedRevision:3});
});

test('GO2-04 adding one sentence and a deadline puts it under things I do',async t=>{
  const ui=await fixture(t);await ui.render();
  await clickAria(ui.d,'添加目标');
  assert.ok(ui.d.querySelector('.action-final-dialog'));
  await input(ui.d,'.action-final-dialog input:not([type])','Generated write launch notes');
  await input(ui.d,'.action-final-dialog input[type=datetime-local]','2026-11-25T09:30');
  await click(ui.d,'添加');
  await ui.settle(()=>ui.d.body.textContent!.includes('Generated write launch notes'));
  const call=ui.calls.find(item=>item.method==='POST'&&item.path==='/api/assistant/goals')!;
  assert.equal(call.body!.title,'Generated write launch notes');
  assert.deepEqual(call.body!.due,{text:'2026-11-25 09:30',at:new Date('2026-11-25T09:30').toISOString()});
  const none=group(ui.d,'none')!;assert.match(none.querySelector('[data-section=mine]')!.textContent!,/Generated write launch notes/);
  assert.equal(ui.d.querySelector('.action-final-dialog'),null);
});

test('GO2-06 edit, pause and archive each send the shown revision and change the matter',async t=>{
  const ui=await fixture(t);await ui.render();
  await clickIn(group(ui.d,'matter:'+ids.release)!,'编辑');
  const textarea=ui.d.querySelector<HTMLTextAreaElement>('.goals-edit textarea')!;assert.ok(textarea);
  await input(ui.d,'.goals-edit textarea','Generated revised release goal');
  await click(ui.d,'保存');
  await ui.settle(()=>ui.d.body.textContent!.includes('Generated revised release goal'));
  assert.ok(group(ui.d,'matter:'+ids.release));
  const edit=ui.calls.find(item=>item.body?.type==='edit')!;assert.deepEqual(edit.body,{type:'edit',matterId:ids.release,expectedRevision:1,goal:'Generated revised release goal'});

  await clickIn(group(ui.d,'matter:'+ids.review)!,'暂停');
  await ui.settle(()=>!group(ui.d,'matter:'+ids.review));
  const pause=ui.calls.find(item=>item.body?.type==='pause')!;assert.deepEqual(pause.body,{type:'pause',matterId:ids.review,expectedRevision:1});
  assert.match(group(ui.d,'none')!.textContent!,/Generated merge repair/,'pausing a matter keeps its items in the explicit no-matter group');

  await clickIn(group(ui.d,'matter:'+ids.release)!,'归档');
  await ui.settle(()=>!group(ui.d,'matter:'+ids.release));
  const archive=ui.calls.find(item=>item.body?.type==='archive')!;assert.deepEqual(archive.body,{type:'archive',matterId:ids.release,expectedRevision:2});
});

test('GO2-07 an old matter revision reports a conflict and never overwrites the remote goal',async t=>{
  const ui=await fixture(t);await ui.render();
  await clickIn(group(ui.d,'matter:'+ids.release)!,'编辑');
  await input(ui.d,'.goals-edit textarea','Generated stale draft');
  const remote=ui.state.matters.find(item=>item.id===ids.release)!;remote.goal='Generated other-client goal';remote.revision=2;
  await click(ui.d,'保存');
  await ui.settle(()=>Boolean(ui.d.querySelector('[role=alert]')));
  assert.match(ui.d.querySelector('[role=alert]')!.textContent!,/事项已变化，需重新读取/);
  assert.equal(ui.d.querySelector<HTMLTextAreaElement>('.goals-edit textarea')!.value,'Generated stale draft');
  assert.equal(ui.state.matters.find(item=>item.id===ids.release)!.goal,'Generated other-client goal');
  const send=ui.calls.find(item=>item.body?.type==='edit')!;assert.equal(send.body!.expectedRevision,1);
  await ui.settle(()=>ui.d.body.textContent!.includes('Generated other-client goal'));
});

test('GO2 links carry the item or matter to chat, library and the workbench project page',async t=>{
  const ui=await fixture(t);await ui.render();
  const release=group(ui.d,'matter:'+ids.release)!;
  const title=release.querySelector<HTMLAnchorElement>('a.goals-group-title')!;
  assert.equal(title.getAttribute('href'),'#/assistant/workbench?matter='+ids.release);
  const materials=release.querySelector<HTMLAnchorElement>('a[aria-label="相关资料"]')!;
  assert.equal(materials.getAttribute('href'),'#/library?matter='+ids.release);
  const matterChat=release.querySelector<HTMLAnchorElement>('a[aria-label="去聊"]')!;
  assert.equal(new URLSearchParams(matterChat.hash.split('?')[1]).get('about'),'matter:'+ids.release);
  const alice=release.querySelector<HTMLElement>('[data-item-id="'+ids.alice+'"]')!;
  const itemChat=alice.querySelector<HTMLAnchorElement>('a[aria-label="去聊"]')!;
  assert.equal(new URLSearchParams(itemChat.hash.split('?')[1]).get('about'),'commitment:'+ids.alice);
  await act(async()=>{[...alice.querySelectorAll('button')].find(item=>item.textContent==='查看原文')!.click();});
  assert.deepEqual(ui.opened,['capture:'+ids.evidence]);
});

test('the empty goal page keeps one sentence and still offers the add control',async t=>{
  const empty:State={matters:[],rows:[],sequence:0};
  const ui=await fixture(t,empty);await ui.render(()=>Boolean(ui.d.querySelector('.goals-empty')));
  assert.equal(ui.d.querySelector('.goals-empty')!.textContent,'没有待办');
  assert.ok(ui.d.querySelector('button[aria-label="添加目标"]'));
});

test('the workbench reads the project matter from the goals route',async t=>{
  assert.equal(workbenchMatterTarget('#/assistant/workbench?matter='+ids.release),ids.release);
  assert.equal(workbenchMatterTarget('#/assistant/workbench?matter=generated'),undefined);
  configureLocale(()=> 'zh-CN');
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/assistant/workbench?matter='+ids.release,pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{},scrollIntoView:()=>{}});dom.window.scrollTo=()=>{};
  const calls:string[]=[],root=createRoot(dom.window.document.getElementById('root')!);
  const api={request:async(path:string)=>{calls.push(path);return {};}} as Api;
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
  await act(async()=>root.render(React.createElement(AssistantWorkbenchPage,{api,range:{}})));
  const request=calls.find(path=>path.startsWith('/api/assistant/workbench?'))!;assert.ok(request);
  const value=JSON.parse(new URLSearchParams(request.split('?')[1]).get('request')!) as {template:string;matterId:string};
  assert.equal(value.template,'project');assert.equal(value.matterId,ids.release);
});
