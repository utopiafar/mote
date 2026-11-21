import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {CHAT_ABOUT_PARAM,pageHash,parseAboutRef,type GoalGroup,type GoalItem,type GoalsView,type Matter,type QueryScope,type WorkspaceView} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {fixtureMemoryResult} from '../../server/test/fixtures/memory-result';
import {ApiError,type Api} from '../src/api';
import {FeaturePage} from '../src/features/runtime';
import type {PageProps} from '../src/features/types';
import {readPage} from '../src/navigation';
import {GoalsPage} from '../src/plugins/assistant/GoalsPage';
import {AssistantWorkbenchPage,workbenchMatterTarget,workbenchTarget} from '../src/plugins/assistant-workbench';
import {chatDom,injectedApi} from './fixtures/chat-dom';

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
const matter=(id:string,goal:string,evidenceIds:string[]=[],template:Matter['template']='project'):Matter=>({id,goal,template,scope:all,state:'active',revision:1,taskIds:[],evidenceIds,correction:null,createdAt:at,updatedAt:at,archivedAt:null});
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
      if(body!.type==='edit'){
        if(body!.goal!==undefined)owner.goal=String(body!.goal);
        if(body!.template!==undefined)owner.template=body!.template as Matter['template'];
        owner.revision++;
      }else{state.matters=state.matters.filter(item=>item!==owner);}
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
async function selectIn(parent:ParentNode,label:string,value:string){
  await act(async()=>{
    const control=parent.querySelector<HTMLSelectElement>('select[aria-label="'+label+'"]');assert.ok(control,label);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control),'value')!.set!.call(control,value);
    control.dispatchEvent(new control.ownerDocument.defaultView!.Event('change',{bubbles:true}));
  });
}
const group=(d:Document,id:string)=>d.querySelector<HTMLElement>('.goals-group[data-group="'+id+'"]');
async function mountWorkbench(t:import('node:test').TestContext,hash:string){
  configureLocale(()=> 'zh-CN');
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{},scrollIntoView:()=>{}});dom.window.scrollTo=()=>{};
  const calls:string[]=[],root=createRoot(dom.window.document.getElementById('root')!);
  const api={request:async(path:string)=>{calls.push(path);return {};}} as Api;
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
  await act(async()=>root.render(React.createElement(AssistantWorkbenchPage,{api,range:{}})));
  const path=calls.find(value=>value.startsWith('/api/assistant/workbench?'));
  return {calls,request:path?JSON.parse(new URLSearchParams(path.split('?')[1]).get('request')!):undefined};
}

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

async function goalsServer(t:import('node:test').TestContext,name:string){
  const {buildApp}=await import('../../server/src/app');
  const directory=mkdtempSync(join(tmpdir(),`mote-${name}-`));
  const token=`generated-${name}-owner`;
  const node=await buildApp({
    path:join(directory,'mote.yaml'),
    privateCredential:{token,tokenPath:'fixture'},
    initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},
      server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
      models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},
        embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}},
  },{backgroundWorker:false,agent:{configured:false,query:async()=>assert.fail('Unexpected model call'),close:async()=>{}}});
  t.after(async()=>{
    try{await node.app.close();}
    finally{rmSync(directory,{recursive:true,force:true});}
  });
  return {node,headers:{authorization:'Bearer '+token}};
}

test('GO2-04 an unlinked manual Todo opens chat with that Todo as its reference',async t=>{
  const f=await chatDom(t,'#/goals');
  const {node,headers}=await goalsServer(t,'goals-about');
  const requests:Call[]=[];
  const api=injectedApi(node.app,headers,(path,init)=>requests.push({path,method:init.method??'GET'})) as Api;
  await act(async()=>f.root.render(React.createElement(GoalsPage,{api,onOpen:()=>{}})));
  await f.waitFor(()=>f.d.querySelector('.goals-empty')&&f.d.querySelector('.goals-add'),'ready goals with add available');
  await f.click('.goals-add');
  const title='Generated unlinked manual Todo';
  await f.field('.action-final-dialog input:not([type])',title);
  await f.click('.action-final-dialog button[type=submit]');

  const rowSelector='.goals-group[data-group=none] [data-section=mine] [data-kind=todo]';
  await f.waitFor(()=>f.d.querySelector(rowSelector),'saved unlinked Todo');
  const row=f.element(rowSelector);
  const id=row.dataset.itemId;
  assert.ok(id);
  assert.equal(row.querySelector('.goals-title')?.textContent,title);
  assert.ok(requests.some(call=>call.method==='POST'&&call.path==='/api/assistant/goals'));
  await f.click(rowSelector+' a.goals-action');
  await f.waitFor(()=>f.w.location.hash.startsWith(pageHash('chat')),'go to chat link navigation');
  const [route,search]=f.w.location.hash.split('?');
  const about=new URLSearchParams(search).get(CHAT_ABOUT_PARAM);
  assert.equal(route,pageHash('chat'));
  assert.equal(about,'todo:'+id);
  assert.deepEqual(parseAboutRef(about),{kind:'todo',id});

  await f.render(api);
  await f.waitFor(()=>f.d.querySelector('.chat-about-reference[data-state=ready]'),'Todo resolved in chat');
  assert.equal(f.d.querySelector('.chat-about-reference strong')?.textContent,title);
  assert.equal(f.d.querySelector('.chat-about-tag > span')?.textContent,title);
  assert.ok(requests.some(call=>call.method==='GET'&&call.path==='/api/assistant/goals/todos/'+id));
  assert.equal(requests.some(call=>call.method==='POST'&&call.path==='/api/conversations/messages'),false);
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

test('GO3-03 the more menu changes a matter to the reading template and its revision advances',async t=>{
  const ui=await fixture(t);await ui.render();
  await selectIn(group(ui.d,'matter:'+ids.release)!,'模板','reading');
  await ui.settle(()=>Boolean(group(ui.d,'matter:'+ids.release)?.querySelector('a.goals-group-title')?.getAttribute('href')?.includes('template=reading')));
  const call=ui.calls.find(item=>item.body?.type==='edit'&&item.body?.template==='reading')!;
  assert.deepEqual(call.body,{type:'edit',matterId:ids.release,expectedRevision:1,template:'reading'});
  const saved=ui.state.matters.find(item=>item.id===ids.release)!;
  assert.equal(saved.revision,2,'the template change consumes one revision');
  assert.equal(saved.template,'reading');
  const href=group(ui.d,'matter:'+ids.release)!.querySelector<HTMLAnchorElement>('a.goals-group-title')!.getAttribute('href')!;
  assert.deepEqual(workbenchTarget(href),{template:'reading',target:ids.release},'reopening the matter uses the reading template');
});

test('GO3-04 the goals page links a travel matter with its template',async t=>{
  const state=base();
  state.matters.find(item=>item.id===ids.review)!.template='travel';
  const ui=await fixture(t,state);await ui.render();
  const href=group(ui.d,'matter:'+ids.review)!.querySelector<HTMLAnchorElement>('a.goals-group-title')!.getAttribute('href')!;
  assert.equal(href,'#/assistant/workbench?matter='+ids.review+'&template=travel');
  assert.deepEqual(workbenchTarget(href),{template:'travel',target:ids.review});
});

test('GO2 links carry the item or matter to chat, library and the workbench project page',async t=>{
  const state=base();
  const eventId=randomUUID();
  state.rows.push({item:{id:eventId,kind:'event',title:'Generated event with progress',direction:'mine',
    inferred:false,revision:1,actions:['complete'],lastProgress:{summary:'Generated update',at,evidenceId:ids.evidence}}});
  const ui=await fixture(t,state);await ui.render();
  const release=group(ui.d,'matter:'+ids.release)!;
  const title=release.querySelector<HTMLAnchorElement>('a.goals-group-title')!;
  assert.equal(title.getAttribute('href'),'#/assistant/workbench?matter='+ids.release+'&template=project');
  const materials=release.querySelector<HTMLAnchorElement>('a[aria-label="相关资料"]')!;
  assert.equal(materials.getAttribute('href'),'#/library?matter='+ids.release);
  const matterChat=release.querySelector<HTMLAnchorElement>('a[aria-label="去聊"]')!;
  assert.equal(new URLSearchParams(matterChat.hash.split('?')[1]).get('about'),'matter:'+ids.release);
  const alice=release.querySelector<HTMLElement>('[data-item-id="'+ids.alice+'"]')!;
  const itemChat=alice.querySelector<HTMLAnchorElement>('a[aria-label="去聊"]')!;
  assert.equal(new URLSearchParams(itemChat.hash.split('?')[1]).get('about'),'commitment:'+ids.alice);
  const eventChat=ui.d.querySelector<HTMLAnchorElement>('[data-item-id="'+eventId+'"] a[aria-label="去聊"]')!;
  assert.equal(new URLSearchParams(eventChat.hash.split('?')[1]).get('about'),'evidence:'+ids.evidence);
  await act(async()=>{[...alice.querySelectorAll('button')].find(item=>item.textContent==='查看原文')!.click();});
  assert.deepEqual(ui.opened,['capture:'+ids.evidence]);
});

test('the empty goal page keeps one sentence and still offers the add control',async t=>{
  const empty:State={matters:[],rows:[],sequence:0};
  const ui=await fixture(t,empty);await ui.render(()=>Boolean(ui.d.querySelector('.goals-empty')));
  assert.equal(ui.d.querySelector('.goals-empty')!.textContent,'没有待办');
  assert.ok(ui.d.querySelector('button[aria-label="添加目标"]'));
});

test('a matter route without a template retries the saved template read before opening the workbench',async t=>{
  const hash='#/assistant/workbench?matter='+ids.release;
  assert.equal(workbenchMatterTarget(hash),ids.release);
  assert.equal(workbenchMatterTarget('#/assistant/workbench?matter=generated'),undefined);
  const f=await chatDom(t,hash),calls:string[]=[];
  let unavailable=true;
  const api={request:async(path:string)=>{
    calls.push(path);
    if(!path.startsWith('/api/assistant/matters/'+ids.release+'?'))return {};
    if(unavailable)throw new ApiError('Generated missing matter',404);
    return {matter:matter(ids.release,'Generated release')};
  }} as Api;
  const range={after:at};
  await act(async()=>f.root.render(React.createElement(AssistantWorkbenchPage,{api,range})));
  const request=()=>calls.find(path=>path.startsWith('/api/assistant/workbench?'));
  await f.waitFor(()=>f.d.querySelector('[role=alert] button'),'the matter read failure offers a retry');
  assert.equal(request(),undefined,'a missing template never sends a guessed workbench request');
  unavailable=false;
  await f.click('[role=alert] button');
  await f.waitFor(request,'the retry opens the saved project template');
  assert.deepEqual(JSON.parse(new URLSearchParams(request()!.split('?')[1]).get('request')!),
    {template:'project',matterId:ids.release,scope:{...all,...range}});
});

test('GO3-04 the workbench reads the travel matter template from the goals route',async t=>{
  const workbench=await mountWorkbench(t,'#/assistant/workbench?matter='+ids.review+'&template=travel');
  assert.equal(workbench.request.template,'travel');
  assert.equal(workbench.request.matterId,ids.review);
  assert.equal(workbench.request.personMemoryId,undefined);
});

test('GO3-04 clicking a goal for a matter beyond the first page opens its saved travel template',async t=>{
  const {featuresReady}=await import('../src/features/bootstrap');
  await featuresReady;
  const f=await chatDom(t,'#/goals');
  const {node,headers}=await goalsServer(t,'goals-paged-workbench');
  const central=injectedApi(node.app,headers);
  const create=(goal:string,template:Matter['template'])=>central.request<Matter>('/api/assistant/matter-commands',{
    method:'POST',body:JSON.stringify({type:'create',requestId:randomUUID(),goal,template,scope:all}),
  });
  t.mock.timers.enable({apis:['Date'],now:Date.parse(at)});
  const travel=await create('Generated trip','travel');
  t.mock.timers.tick(1000);
  for(let index=0;index<100;index++)await create('Generated project '+index,'project');
  t.mock.timers.reset();

  const list='/api/assistant/matters?'+new URLSearchParams({scope:JSON.stringify(all),limit:'100'});
  const first=await central.request<{items:Matter[];nextCursor:string|null}>(list);
  assert.equal(first.items.length,100);
  assert.ok(first.items.every(item=>item.id!==travel.id));
  assert.ok(first.nextCursor);
  const second=await central.request<{items:Matter[]}>(list+'&'+new URLSearchParams({cursor:first.nextCursor}));
  assert.equal(second.items.find(item=>item.id===travel.id)?.template,'travel');

  const evidenceId=randomUUID(),text='Generated promise to book the trip';
  await central.request('/api/notes',{method:'POST',body:JSON.stringify({id:evidenceId,deviceId:'generated-device',
    deviceName:'Generated',platform:'import',capturedAt:at,text})});
  node.featureServices.assistantCommitments.publish({
    commitmentId:randomUUID(),eventId:randomUUID(),kind:'commitment',occurredAt:null,summary:text,
    changes:{title:text,matterId:travel.id,status:'confirmed'},
    evidence:[{id:evidenceId,quote:text,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[evidenceId]},
  },undefined,all,()=>{});

  const views:WorkspaceView[]=[];
  const api={...central,request:async<T>(path:string,init?:RequestInit):Promise<T>=>{
    const value=await central.request<T>(path,init);
    if(path.startsWith('/api/assistant/workbench?'))views.push(value as WorkspaceView);
    return value;
  }} as Api;
  const props:PageProps={api,range:{},status:null,devices:[],activity:{apps:[],devices:[],totalDurationMs:0,captures:0},
    insights:[],onPage:()=>{},onOpen:ref=>f.opened.push(ref),archiveTab:'materials',setArchiveTab:()=>{},
    timelineRevision:0,refresh:()=>{},disconnect:()=>{},sessionLifetime:'session',changeSessionLifetime:()=>{}};
  const renderRoute=()=>f.root.render(React.createElement(React.Suspense,{fallback:null},
    React.createElement(FeaturePage,{page:readPage(f.w.location.hash),props})));
  assert.equal(readPage(f.w.location.hash),'assistantGoals');
  await act(async()=>renderRoute());
  const title=`.goals-group[data-group="matter:${travel.id}"] a.goals-group-title`;
  await f.waitFor(()=>f.d.querySelector(title),'the travel matter appears in goals');
  assert.equal(f.element(title).textContent,travel.goal);
  await f.click(title);
  await f.waitFor(()=>readPage(f.w.location.hash)==='assistantWorkbench','the goal link opens the workbench');
  await act(async()=>renderRoute());
  await f.waitFor(()=>views.length>0,'the workbench receives the Central response');
  assert.deepEqual(views.map(view=>view.descriptor.id),['assistant.workbench.travel']);
  assert.deepEqual(views[0].request,{template:'travel',matterId:travel.id,scope:all});
  await f.waitFor(()=>f.d.querySelector('.declarative-detail')?.textContent?.includes(travel.goal),
    'the workbench renders the same matter');
});

test('GO3-05 clicking a person row in Memory opens that person’s workbench',async t=>{
  const {featuresReady}=await import('../src/features/bootstrap');
  await featuresReady;
  const f=await chatDom(t,'#/assistant/memory');
  const {node,headers}=await goalsServer(t,'memory-workbench');
  const noteId=randomUUID(),title='Generated Mina',promise='Generated design handoff';
  const body=title+' will provide the design handoff.';
  const note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{
    id:noteId,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:at,text:body,
  }});
  assert.equal(note.statusCode,201,note.body);
  const extracted=node.memories.extract(fixtureMemoryResult(node.memories,{
    answer:JSON.stringify({memories:[{title,statement:body+' ['+noteId+']',uncertainty:'Generated identity',evidenceIds:[noteId]}]}),
    citations:[{id:noteId,capturedAt:at,appName:'Generated',excerpt:body}],trace:[],runId:randomUUID(),
  }),'generated').items[0];
  assert.ok(extracted);
  const person=node.memories.publish(extracted.id,extracted.version);
  node.featureServices.assistantCommitments.publish({
    commitmentId:randomUUID(),eventId:randomUUID(),kind:'commitment',occurredAt:null,summary:body,
    changes:{title:promise,personMemoryId:person.id,status:'confirmed'},
    evidence:[{id:noteId,quote:body,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[noteId]},
  },undefined,all,()=>{});

  const calls:Call[]=[],views:WorkspaceView[]=[];
  const central=injectedApi(node.app,headers,(path,init)=>calls.push({path,method:init.method??'GET'}));
  const api={...central,request:async<T>(path:string,init?:RequestInit):Promise<T>=>{
    const value=await central.request<T>(path,init);
    if(path.startsWith('/api/assistant/workbench?'))views.push(value as WorkspaceView);
    return value;
  }} as Api;
  const props:PageProps={api,range:{},status:null,devices:[],activity:{apps:[],devices:[],totalDurationMs:0,captures:0},
    insights:[],onPage:()=>{},onOpen:ref=>f.opened.push(ref),archiveTab:'materials',setArchiveTab:()=>{},
    timelineRevision:0,refresh:()=>{},disconnect:()=>{},sessionLifetime:'session',changeSessionLifetime:()=>{}};
  const renderRoute=()=>f.root.render(React.createElement(React.Suspense,{fallback:null},
    React.createElement(FeaturePage,{page:readPage(f.w.location.hash),props})));
  assert.equal(readPage(f.w.location.hash),'assistantMemory');
  await act(async()=>renderRoute());
  const row='.memory-page-row[data-type="people"] .memory-page-row-main';
  await f.waitFor(()=>f.d.querySelector(row),'generated person appears in Memory');
  await act(async()=>{
    const people=[...f.d.querySelectorAll<HTMLButtonElement>('.memory-page-filters button')]
      .find(button=>button.textContent?.trim().startsWith('人物 '));
    assert.ok(people);
    people.click();
  });
  assert.equal(f.element(row).querySelector('strong')?.textContent,title);
  await f.click(row);
  await f.waitFor(()=>readPage(f.w.location.hash)==='assistantWorkbench','person row navigates to the registered workbench');
  const hash=f.w.location.hash;
  assert.deepEqual(workbenchTarget(hash),{template:'person',target:person.id});
  assert.equal(workbenchMatterTarget(hash),undefined,'a Memory person is not a matter target');
  await act(async()=>renderRoute());
  await f.waitFor(()=>f.d.querySelector('.declarative-detail')?.textContent?.includes(title),'the person template renders the same Memory');
  assert.ok(f.d.querySelector('.declarative-list')?.textContent?.includes(title));
  assert.ok([...f.d.querySelectorAll('.declarative-list')].some(list=>list.textContent?.includes(promise)));
  assert.deepEqual(views.map(view=>view.descriptor.id),['assistant.workbench.person']);
  const workbench=calls.filter(call=>call.path.startsWith('/api/assistant/workbench?'));
  assert.equal(workbench.length,1);
  assert.equal(workbench[0].method,'GET');
  assert.deepEqual(JSON.parse(new URLSearchParams(workbench[0].path.split('?')[1]).get('request')!),
    {template:'person',personMemoryId:person.id,scope:all});
  assert.equal(calls.some(call=>call.path.startsWith('/api/memories/'+person.id+'?')),false);
  assert.deepEqual(f.opened,[]);
});
