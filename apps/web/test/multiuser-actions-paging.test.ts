import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {configureLocale} from '@mote/shared/i18n';
import {modelFixture,event} from '../../server/test/fixtures/scoped-actions.js';
import {password,waitForState} from '../../server/test/fixtures/scoped-query-accounts.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';
import {createApi,type Api} from '../src/api.js';
import {Actions} from '../src/Actions.js';
configureLocale(()=> 'zh-CN');

test('original Actions walks actual opaque owner pages and retires a held old page on account replacement',async t=>{
 const f=await modelFixture(t);let batch=0,count=8;
 f.scripts.set('A',(body,_raw,res)=>{const envelope=JSON.parse(typeof body.messages[0].content==='string'?body.messages[0].content:body.messages[0].content[0].text),record=envelope.untrustedEvidence[0],uses=body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content.filter((part:any)=>part.type==='tool_use'):[]),stage=uses.length+1;
  if(!uses.some((use:any)=>use.name==='evidence'))return writeMessagesResponse(res,{stage,tool:{name:'evidence',args:{ids:[record.id]}}});
  writeMessagesResponse(res,{stage,text:JSON.stringify({answer:JSON.stringify({actions:Array.from({length:count},(_,i)=>({kind:'calendar.create',event:{...event,title:'GENERATED_A_PAGE_'+batch+'_'+i},uncertainty:'Generated page fixture',sameAs:null,evidence:[{id:record.id,quote:'GENERATED_A_PRIVATE_APPOINTMENT'}]}))}),citationIds:[record.id]})});
 });
 let expected=0;
 for(const [index,size]of [8,8,5].entries()){
  batch=index;count=size;const started=Date.now(),before=f.requests.length;await f.ingest(f.a,'A','page-item-'+index);if(index===0)await f.enable(f.a);else await f.ok(f.a.token,'/api/actions/retry','POST',{});expected+=size;
  try{await waitForState(()=>f.ok(f.a.token,'/api/actions?limit=100'),value=>value.items.length===expected,'actual model-produced page '+index,30000);}
  finally{console.error('generated Actions paging preparation',JSON.stringify({index,elapsed:Date.now()-started,providerRequests:f.requests.length-before,tasks:f.read(db=>db.prepare("SELECT kind,state,attempts,available_at,error FROM execution_steps WHERE user_id=? AND kind LIKE 'actions.%' ORDER BY created_at,id").all(f.a.userId))}));}
 }
 await f.ingest(f.b,'B');await f.enable(f.b);await f.proposal(f.b);
 const first=await f.ok(f.a.token,'/api/actions');assert.equal(first.items.length,20);assert.equal(typeof first.nextCursor,'string');assert.ok(first.nextCursor);assert.equal((await f.request(f.b.token,'/api/actions?cursor='+encodeURIComponent(first.nextCursor))).statusCode,400);
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/actions',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();let cookie='',current:Api|undefined,hold=false,release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);const paths:string[]=[];
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(path:string,init:RequestInit={})=>{const headers=new Headers(init.headers);headers.set('cookie',cookie);paths.push(path);const r=await f.node.app.inject({url:path,method:init.method as any??'GET',headers:Object.fromEntries(headers),...(init.body?{payload:String(init.body)}:{})});if(hold&&path.startsWith('/api/actions?')&&new URL(path,'http://localhost').searchParams.get('cursor')===first.nextCursor){hold=false;assert.equal(r.statusCode,200);entered();await held;}return new Response(r.rawPayload,{status:r.statusCode,headers:r.headers as Record<string,string>});}})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document;
 t.after(async()=>{release();current?.close?.();await act(async()=>root.unmount());for(const [key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const login=async(username:string)=>{const r=await f.request(undefined,'/api/auth/login','POST',{username,password,mode:'web'});assert.equal(r.statusCode,200,r.body);cookie=String(r.headers['set-cookie']).split(';')[0];const api=createApi({mode:'web',origin:'http://localhost',...r.json()},undefined,()=>current===api);current?.close?.();current=api;return api;};
 const render=async(api:Api)=>act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(Actions,{api,onOpen:()=>{}})));await delay(30);}),wait=async(ready:()=>boolean,label:string)=>{for(let n=0;n<200&&!ready();n++)await act(async()=>delay(10));assert.ok(ready(),label+' '+d.body.textContent);},press=async(label:string)=>act(async()=>{const button=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent===label);assert.ok(button,label);button.click();await delay(30);});
 const a=await login('generated-a');await render(a);await wait(()=>d.querySelectorAll('.action-card').length===20,'actual first page');await press('更早建议');await wait(()=>d.querySelectorAll('.action-card').length===1,'actual opaque next page');assert.ok(paths.some(path=>path.startsWith('/api/actions?')&&new URL(path,'http://localhost').searchParams.get('cursor')===first.nextCursor));assert.match(d.querySelector('.action-card')!.textContent!,/GENERATED_A_PAGE_/);
 await press('最新建议');await wait(()=>d.querySelectorAll('.action-card').length===20,'first page restoration');hold=true;await press('更早建议');await ready;const b=await login('generated-b');await render(b);await wait(()=>d.querySelectorAll('.action-card').length===1&&d.querySelector('.action-card')!.textContent!.includes('Generated B'),'B actual fresh page');release();await act(async()=>delay(30));assert.equal(d.querySelectorAll('.action-card').length,1);assert.doesNotMatch(d.querySelector('.actions-page')!.textContent!,/GENERATED_A_PAGE_/);assert.equal(d.querySelector('[role="dialog"]'),null);
});
