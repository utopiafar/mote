import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import {CHAT_ABOUT_PARAM,formatAboutRef,pageHash,type IdeaItem,type IdeasView,type NavState,type StartedIdea} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import type {Api} from '../src/api.js';
import {IdeasPage} from '../src/plugins/assistant/IdeasPage.js';
import {NavStateContext} from '../src/use-nav-state.js';

configureLocale(()=> 'zh-CN');
const navState=(cards:string):NavState=>({revisions:{library:'generated-library',cards,commitments:'generated-commitments',matters:'generated-matters',memory:'generated-memory',sources:'generated-sources',plugins:'generated-plugins'},badges:{ideas:3}});

function idea(overrides:Partial<IdeaItem>&{title:string}):IdeaItem{
  return {id:overrides.id??randomUUID(),source:'card',kind:'suggestion',detail:'生成的说明。',revision:3,seq:5,
    actions:['start','later','ignore'],...overrides};
}
function started(overrides:Partial<StartedIdea>&{title:string}):StartedIdea{
  return {taskId:overrides.taskId??randomUUID(),state:'running',progress:'读取资料 2/5',updatedAt:'2026-11-20T09:00:00+08:00',...overrides};
}
function view(changes:Partial<IdeasView>={}):IdeasView{
  return {revision:'generated-ideas-1',watermark:11,mine:[],yours:[],started:[],...changes};
}

async function fixture(t:import('node:test').TestContext){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/ideas',pretendToBeVisual:true});
  const before=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{
    await act(async()=>root.unmount());
    for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
    dom.window.close();
  });
  return {root,d:dom.window.document,w:dom.window};
}

type Request={path:string;method:string;body?:string};
function fakeApi(state:{view:IdeasView;card?:{taskScope:unknown}},requests:Request[]){
  const remove=(id:string)=>{
    state.view={...state.view,mine:state.view.mine.filter(item=>item.id!==id),yours:state.view.yours.filter(item=>item.id!==id)};
  };
  return {
    setAgentTimeout:()=>{},
    request:async(path:string,init?:{method?:string;body?:string})=>{
      const method=init?.method??'GET';
      requests.push({path,method,...(init?.body?{body:init.body}:{})});
      if(method==='GET'&&path.startsWith('/api/assistant/ideas?'))return structuredClone(state.view);
      if(method==='GET'&&path.startsWith('/api/assistant-cards/')){
        const id=decodeURIComponent(path.split('/')[3]!.split('?')[0]!);
        const item=[...state.view.mine,...state.view.yours].find(value=>value.id===id);
        assert.ok(item,'the card detail targets a returned idea');
        return {id,title:item.title,revision:item.revision,...state.card};
      }
      if(method==='POST'&&path==='/api/assistant/tasks'){
        const body=JSON.parse(init!.body!);
        remove(body.cardId);
        state.view={...state.view,started:[...state.view.started,started({taskId:randomUUID(),title:body.goal})]};
        return {taskId:randomUUID(),requestId:body.requestId};
      }
      const feedback=/^\/api\/assistant-cards\/([^/]+)\/feedback\?/.exec(path);
      if(method==='POST'&&feedback){
        remove(decodeURIComponent(feedback[1]!));
        return {};
      }
      if(method==='POST'&&path==='/api/assistant/ideas/ignore-all'){
        const body=JSON.parse(init!.body!);
        assert.equal(body.upToSeq,state.view.watermark);
        state.view={...state.view,mine:[],yours:state.view.yours.filter(item=>item.source==='owner-question')};
        return {ignored:2,revision:'generated-ideas-2'};
      }
      throw new Error('Unexpected fixture request: '+method+' '+path);
    },
  } as unknown as Api;
}

const settle=async(w:JSDOM['window'])=>{await act(async()=>{await new Promise(resolve=>w.setTimeout(resolve,0));await Promise.resolve();});};
const tree=(api:Api,refresh:()=>void,revision='cards-1')=>React.createElement(NavStateContext.Provider,{value:navState(revision)},React.createElement(IdeasPage,{api,refresh}));
const row=(d:Document,id:string)=>d.querySelector<HTMLElement>(`.idea-row[data-card-id="${id}"], .idea-row[data-task-id="${id}"]`)!;
const button=(scope:ParentNode,label:string)=>Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.trim()===label||value.getAttribute('aria-label')===label);
const chatHref=(kind:'card'|'question',id:string)=>pageHash('chat',{[CHAT_ABOUT_PARAM]:formatAboutRef({kind,id})});

test('ID2-01 hover and keyboard focus reveal the server-provided row actions',async t=>{
  const suggestion=idea({title:'我可以今晚读完同步协议草案'}),question=idea({title:'上线公告由你写，还是林舟写？',kind:'question',actions:['answer','later','ignore']});
  const state={view:view({mine:[suggestion],yours:[question],watermark:7})},api=fakeApi(state,[]);
  const {root,d,w}=await fixture(t);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  const target=row(d,suggestion.id);
  assert.equal(target.dataset.actions,undefined);
  assert.ok(button(target,'开始')&&button(target,'稍后')&&button(target,'忽略'),'server actions render even before hover');
  assert.equal(button(target,'开始')!.getAttribute('tabindex'),null,'action buttons stay in the tab order');
  assert.equal(button(target,'开始')!.disabled,false);
  await act(async()=>{target.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));});
  assert.equal(target.dataset.actions,'visible');
  await act(async()=>{target.dispatchEvent(new w.MouseEvent('mouseout',{bubbles:true,relatedTarget:d.body}));});
  assert.equal(target.dataset.actions,undefined);
  await act(async()=>button(target,'开始')!.focus());
  assert.equal(target.dataset.actions,'visible','keyboard focus reveals the same actions');
  await act(async()=>d.querySelector<HTMLInputElement>('.ideas-search input')!.focus());
  assert.equal(target.dataset.actions,undefined,'focus leaving the row hides them again');
});

test('ID2-02 answering opens chat with this exact question as the reference',async t=>{
  const cardQuestion=idea({title:'上线公告由你写，还是林舟写？',kind:'question',actions:['answer','later','ignore']});
  const ownerQuestion=idea({title:'周六回家吃饭，要把读书会挪走吗？',source:'owner-question',kind:'needs-info',actions:['answer']});
  const state={view:view({yours:[cardQuestion,ownerQuestion]})},api=fakeApi(state,[]);
  const {root,d,w}=await fixture(t);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  const cardLink=row(d,cardQuestion.id).querySelector<HTMLAnchorElement>('.idea-answer')!;
  const ownerLink=row(d,ownerQuestion.id).querySelector<HTMLAnchorElement>('.idea-answer')!;
  assert.ok(cardLink,'a question card can be answered');
  assert.ok(ownerLink,'a clarification can be answered');
  assert.equal(cardLink.getAttribute('href'),chatHref('card',cardQuestion.id));
  assert.equal(ownerLink.getAttribute('href'),chatHref('question',ownerQuestion.id));
  assert.ok(cardLink.getAttribute('href')!.startsWith('#/chat?about='),'the action is a chat link, not a local edit');
});

test('ID2-03 started rows show a completion mark with the current progress and follow the cards revision',async t=>{
  const running=started({title:'整理本周发布进展',progress:'读取资料 2/5'});
  const state={view:view({started:[running]})},api=fakeApi(state,[]);
  const {root,d,w}=await fixture(t);
  const render=(revision:string)=>root.render(tree(api,()=>{},revision));
  await act(async()=>render('cards-1'));
  await settle(w);
  const target=row(d,running.taskId);
  assert.equal(target.dataset.idea,'started');
  assert.ok(target.querySelector('.idea-check'),'the row ends with a completion mark');
  assert.match(target.textContent!,/读取资料 2\/5/);
  state.view=view({started:[{...running,progress:'读取资料 4/9',updatedAt:'2026-11-20T10:00:00+08:00'}]});
  await act(async()=>render('cards-2'));
  await settle(w);
  assert.match(row(d,running.taskId).textContent!,/读取资料 4\/9/);
});

test('ID2-04 ignoring everything uses the visible watermark, clears the list and refreshes the badge read',async t=>{
  const state={view:view({mine:[idea({title:'我可以整理发布清单'}),idea({title:'我可以对比两版设计稿'})],watermark:9})},requests:Request[]=[],refreshed:string[]=[];
  const {root,d,w}=await fixture(t),api=fakeApi(state,requests);
  await act(async()=>root.render(tree(api,()=>refreshed.push('nav'))));
  await settle(w);
  assert.equal(d.querySelectorAll('.idea-row').length,2);
  await act(async()=>button(d,'全部忽略')!.click());
  await settle(w);
  const ignoreAll=requests.find(request=>request.path==='/api/assistant/ideas/ignore-all')!;
  assert.ok(ignoreAll,'the bulk command is sent');
  assert.deepEqual(JSON.parse(ignoreAll.body!),{upToSeq:9});
  assert.equal(d.querySelectorAll('.idea-row').length,0);
  assert.equal(d.querySelector('.ideas-empty')!.textContent,'没有新点子');
  assert.deepEqual(refreshed,['nav'],'the shared nav-state read refreshes so the ideas badge can drop');
});

test('ID2-05 an empty page shows only the single empty sentence',async t=>{
  const state={view:view()},api=fakeApi(state,[]);
  const {root,d,w}=await fixture(t);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  assert.equal(d.querySelectorAll('.idea-row').length,0);
  assert.equal(d.querySelectorAll('.ideas-empty').length,1);
  assert.equal(d.querySelector('.ideas-empty')!.textContent,'没有新点子');
});

test('filters and search stay local and use the three server-provided groups',async t=>{
  const mine=idea({title:'我可以准备评审讲稿'}),yours=idea({title:'发布公告谁来写？',kind:'question',actions:['answer','later','ignore']}),done=started({title:'整理发布进展'});
  const state={view:view({mine:[mine],yours:[yours],started:[done]})},api=fakeApi(state,[]);
  const {root,d,w}=await fixture(t);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  assert.deepEqual(Array.from(d.querySelectorAll('.ideas-filters button')).map(value=>value.textContent),[ '全部 3','需要你 1','我来做 1','已开始 1']);
  await act(async()=>d.querySelector<HTMLButtonElement>('[data-filter="yours"]')!.click());
  await settle(w);
  assert.equal(d.querySelectorAll('.idea-row').length,1);
  assert.equal(d.querySelector('.idea-row')!.getAttribute('data-card-id'),yours.id);
  await act(async()=>d.querySelector<HTMLButtonElement>('[data-filter="all"]')!.click());
  await settle(w);
  const input=d.querySelector<HTMLInputElement>('.ideas-search input')!;
  await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value')!.set!.call(input,'讲稿');input.dispatchEvent(new w.Event('input',{bubbles:true}));input.dispatchEvent(new w.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});
  await settle(w);
  assert.equal(input.value,'讲稿');
  assert.equal(d.querySelectorAll('.idea-row').length,1);
  assert.equal(d.querySelector('.idea-row')!.getAttribute('data-card-id'),mine.id);
});

test('starting a suggestion reads the card scope and posts exactly one task',async t=>{
  const suggestion=idea({title:'我可以整理发布清单',revision:4}),state={view:view({mine:[suggestion],watermark:4}),card:{taskScope:{kind:'selection',evidenceIds:['generated-evidence']}}},requests:Request[]=[];
  const api=fakeApi(state,requests),{root,d,w}=await fixture(t);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  await act(async()=>button(row(d,suggestion.id),'开始')!.click());
  await settle(w);
  const detail=requests.find(request=>request.method==='GET'&&request.path.startsWith('/api/assistant-cards/'))!;
  assert.ok(detail,'the card detail supplies the acceptance scope');
  assert.deepEqual(JSON.parse(new URLSearchParams(detail.path.split('?')[1]).get('scope')!),{kind:'all'});
  const task=requests.filter(request=>request.method==='POST'&&request.path==='/api/assistant/tasks');
  assert.equal(task.length,1);
  const body=JSON.parse(task[0]!.body!);
  assert.equal(body.cardId,suggestion.id);
  assert.equal(body.expectedRevision,4);
  assert.equal(body.goal,suggestion.title);
  assert.deepEqual(body.scope,state.card.taskScope);
  assert.match(body.requestId,/^[0-9a-f-]{36}$/);
});

test('the ideas page owns the nav item and the standalone question list entry is gone',async()=>{
  const {featuresReady}=await import('../src/features/bootstrap.js');
  const {readPage,workspaceNavigation}=await import('../src/navigation.js');
  const {webFeatures}=await import('../src/features/registry.js');
  await featuresReady;
  assert.equal(readPage('#/ideas'),'assistantIdeas');
  const page=webFeatures.page('assistantIdeas')!;
  assert.equal(page.route,'ideas');
  assert.equal(page.navItem,'ideas');
  assert.ok(workspaceNavigation().daily.some(value=>'id' in value&&value.id==='ideas'&&value.page==='assistantIdeas'));
  assert.deepEqual(webFeatures.views('panel',{kind:'mote.ask.history',schemaVersion:1,representation:'standalone'}),[]);
});
