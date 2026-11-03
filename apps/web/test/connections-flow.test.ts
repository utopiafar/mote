import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app';
import {Connections} from '../src/plugins/sources/Connections';
import {ApiError,type Api} from '../src/api';
import {resources} from '../src/resource-cache';

const button=(d:Document,label:string)=>{const b=[...d.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);assert.ok(b,label);return b;};
async function ui(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/connections/access',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=>'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,navigator:{clipboard:{writeText:async()=>{throw Error('Generated clipboard denied');}}},IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [k,v] of before){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}configureLocale(()=>locale);dom.window.close();});
 const tick=async()=>{await act(async()=>new Promise(r=>setTimeout(r,0)));};
 return {d:dom.window.document,dom,root,tick,render:async(api:Api)=>act(async()=>root.render(React.createElement(Connections,{api,serverUrl:'https://generated.invalid',devices:[]})))};
}

test('real owner credentials remain separate, generation is one-time, and cancelled revocation preserves access',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-access-ui-')),token=randomUUID()+randomUUID();
 const node=await buildApp({dataDir:directory,token,tokenPath:'generated',profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:30e6,maxExportBytes:1e6,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',connectors:{directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'generated-static-read-token-only-12345',mcpWriteEnabled:true,mcpWriteToken:'generated-static-write-token-only-12345',mcpWriteSourceIds:['generated-source']}},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in connection UI');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token};
 const make=async(label:string,access='read')=>{const r=await node.app.inject({method:'POST',url:'/api/connections/mcp',headers,payload:{label,access,serverUrl:'https://generated.invalid'}});assert.equal(r.statusCode,200);return r.json();};
 const first=await make('Generated read Agent'),writer=await make('Generated write Agent','write'),revoked=await make('Generated old Agent');
 await node.app.inject({method:'DELETE',url:'/api/connections/'+revoked.credential.id,headers});
 const {root,d,render,tick}=await ui(t);const until=async(check:()=>boolean)=>{for(let i=0;i<150;i++){if(check())return;await act(async()=>new Promise(r=>setTimeout(r,10)));}assert.fail(d.body.textContent??'Generated UI did not settle');};let denied=false;const writes:{path:string;body:unknown}[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{
  if(path==='/api/connections'&&denied)throw new ApiError('Generated owner revoked',403);
  if(init?.method&&init.method!=='GET')writes.push({path,body:JSON.parse(String(init.body||'{}'))});
  const r=await node.app.inject({method:(init?.method??'GET') as 'GET',url:path,headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
  if(r.statusCode>=400)throw new ApiError(r.json().error??'Generated API failure',r.statusCode);return r.json();
 }} as Api;
 await render(api);assert.match(d.body.textContent!,/2 个有效授权/);assert.doesNotMatch(d.querySelector('.access-list')!.textContent!,/Generated old Agent/);assert.equal(d.querySelector('form'),null);
 await act(async()=>button(d,'全部').click());assert.match(d.querySelector('.access-list')!.textContent!,/Generated old Agent/);
 await act(async()=>button(d,'新建连接').click());assert.equal(d.querySelector<HTMLSelectElement>('[aria-label="MCP 访问权限"]')!.value,'read');
 await act(async()=>{const form=d.querySelector('form')!;form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});await until(()=>Boolean(d.querySelector('[aria-label="MCP JSON"]')));
 assert.equal(writes.filter(w=>w.path==='/api/connections/mcp').length,1);assert.deepEqual(writes[0].body,{serverUrl:'https://generated.invalid',label:'我的 AI 助手',access:'read'});
 const content=d.querySelector<HTMLTextAreaElement>('[aria-label="MCP JSON"]')!.value,config=JSON.parse(content);assert.match(config.mcpServers.mote.headers.Authorization,/^Bearer /);assert.equal(config.mcpServers.mote.url,'https://generated.invalid/mcp');
 await act(async()=>button(d,'复制 MCP JSON').click());assert.match(d.body.textContent!,/无法访问剪贴板/);assert.equal(d.querySelector<HTMLTextAreaElement>('[aria-label="MCP JSON"]')!.value,content);
 const generated=(await node.app.inject({method:'GET',url:'/api/connections',headers})).json().items.find((value:{label:string})=>value.label==='我的 AI 助手');assert.ok(generated&&generated.id!==first.credential.id);
 await act(async()=>button(d,'已保存，隐藏凭据').click());assert.equal(d.querySelector('[aria-label="MCP JSON"]'),null);assert.doesNotMatch(d.body.textContent!,new RegExp(config.mcpServers.mote.headers.Authorization));assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('connection'),generated.id,'hide opens exactly the new credential, not an existing row or the list');assert.equal(d.querySelector('h1')!.textContent,'我的 AI 助手');assert.match(d.querySelector('.access-properties')!.textContent!,/只读归档资料/);assert.equal(d.querySelector('.access-detail details')!.hasAttribute('open'),false,'identifiers remain folded metadata');assert.ok(!location.hash.includes('Bearer')&&!location.hash.includes(config.mcpServers.mote.headers.Authorization));assert.ok(!JSON.stringify({...localStorage}).includes(config.mcpServers.mote.headers.Authorization),'one-time credential is never persisted in local storage');
 await act(async()=>{location.hash='#/connections/access?connection=generated';window.dispatchEvent(new window.HashChangeEvent('hashchange'));});assert.equal(d.querySelector('[aria-label="MCP JSON"]'),null,'browser history cannot restore a full credential');await act(async()=>root.render(null));await render(api);assert.equal(d.querySelector('[aria-label="MCP JSON"]'),null,'fresh page instance cannot restore the hidden secret');assert.ok(!d.body.textContent!.includes(config.mcpServers.mote.headers.Authorization));
 await act(async()=>{location.hash='#/connections/access?connection='+first.credential.id;window.dispatchEvent(new window.HashChangeEvent('hashchange'));});assert.equal(d.querySelector('h1')!.textContent,'Generated read Agent');assert.ok(!d.body.textContent!.includes(first.config.mcpServers.mote.headers.Authorization));
 await act(async()=>button(d,'撤销连接').click());assert.ok(d.querySelector('[role="dialog"]'));await act(async()=>button(d,'取消').click());assert.equal(writes.filter(w=>w.path.endsWith(first.credential.id)).length,0);
 await act(async()=>button(d,'撤销连接').click());await act(async()=>button(d,'确认撤销').click());await until(()=>!d.querySelector('[role="dialog"]'));assert.equal(writes.filter(w=>w.path.endsWith(first.credential.id)).length,1);assert.equal(node.connections.authenticate(first.config.mcpServers.mote.headers.Authorization),undefined);assert.ok(node.connections.authenticate(writer.config.mcpServers.mote.headers.Authorization));
 denied=true;await act(async()=>resources(api).invalidate(k=>k==='/api/connections'));assert.match(d.body.textContent!,/Generated owner revoked/);assert.doesNotMatch(d.body.textContent!,/Generated read Agent|Generated write Agent/);
});

test('late generation cannot reveal credentials after leaving its form or changing the authenticated owner',async t=>{
 const {d,render,tick}=await ui(t);let finish!:(value:unknown)=>void;
 const pending=new Promise(resolve=>finish=resolve),inventory={items:[],mcp:{enabled:true,writeEnabled:false,writeSourceIds:[]}};
 const api={request:async(path:string,init?:RequestInit)=>init?.method==='POST'?pending:path==='/api/configuration'?{groups:[]}:inventory} as Api;
 await render(api);await act(async()=>button(d,'新建连接').click());await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>{location.hash='#/connections/access';window.dispatchEvent(new window.HashChangeEvent('hashchange'));});
 await act(async()=>finish({credential:{id:randomUUID(),label:'Generated late',scope:'mcp-read'},config:{mcpServers:{mote:{headers:{Authorization:'Bearer GENERATED_LATE_SECRET'}}}}}));await tick();assert.equal(d.querySelector('[aria-label="MCP JSON"]'),null);assert.ok(!d.body.textContent!.includes('GENERATED_LATE_SECRET'));
 const next={request:async(path:string)=>path==='/api/configuration'?{groups:[]}:inventory} as Api;await render(next);assert.equal(d.querySelector('[aria-label="MCP JSON"]'),null);
});

test('credential expiry removes it from effective access without inventing connection health',async t=>{
 const now=Date.parse('2026-10-29T06:00:00Z');t.mock.timers.enable({apis:['Date','setInterval'],now});
 const {d,render}=await ui(t),id=randomUUID();
 const inventory={items:[{id,label:'Generated expiring Agent',scope:'mcp-read',createdAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+1000).toISOString(),serverUrl:'https://generated.invalid',tokenHint:'generated…hint'}],mcp:{enabled:true,writeEnabled:false,writeSourceIds:[]}};
 const api={request:async(path:string)=>path==='/api/configuration'?{groups:[]}:inventory} as Api;
 await render(api);assert.match(d.body.textContent!,/1 个有效授权/);assert.match(d.querySelector('.access-list')!.textContent!,/Generated expiring Agent/);
 await act(async()=>t.mock.timers.tick(1500));assert.match(d.body.textContent!,/0 个有效授权/);assert.doesNotMatch(d.querySelector('.access-list')!.textContent!,/Generated expiring Agent/);
 await act(async()=>button(d,'全部').click());assert.match(d.querySelector('.access-list')!.textContent!,/Generated expiring Agent.*已到期/s);assert.doesNotMatch(d.querySelector('.access-list')!.textContent!,/授权有效|最近使用|已连接/);
});

test('late replacement revocation cannot erase a different owner invitation or issue another old-node invitation',async t=>{
 const {root,d,tick}=await ui(t);let finish!:(value:unknown)=>void,oldWrites=0;const pending=new Promise(resolve=>finish=resolve),inventory={items:[],mcp:{enabled:true,writeEnabled:false,writeSourceIds:[]}};
 const invitation=(code:string)=>({scope:'owner',invitation:{format:'mote.connection',version:1,serverUrl:'https://generated.invalid',code:code.repeat(43),expiresAt:new Date(Date.now()+600000).toISOString()},uri:'mote://generated-'+code});
 const old={request:async(path:string,init?:RequestInit)=>{if(path.endsWith('/invitations/revoke'))return pending;if(init?.method==='POST'){oldWrites++;return invitation('a');}return path==='/api/configuration'?{groups:[]}:inventory;}} as Api;
 const next={request:async(path:string,init?:RequestInit)=>init?.method==='POST'?invitation('b'):path==='/api/configuration'?{groups:[]}:inventory} as Api;
 const render=(api:Api)=>act(async()=>root.render(React.createElement(Connections,{api,serverUrl:'https://generated.invalid',devices:[],mode:'device'})));await render(old);await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await act(async()=>button(d,'修改连接设置').click());await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(oldWrites,1);
 await render(next);await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(JSON.parse(d.querySelector<HTMLTextAreaElement>('[aria-label="连接邀请 JSON"]')!.value).code,'b'.repeat(43));await act(async()=>finish({}));await tick();assert.equal(oldWrites,1);assert.equal(JSON.parse(d.querySelector<HTMLTextAreaElement>('[aria-label="连接邀请 JSON"]')!.value).code,'b'.repeat(43),'late old-node replacement cannot clear the current owner invitation');
});
