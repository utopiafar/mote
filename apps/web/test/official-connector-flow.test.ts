import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {createApi,type Api} from '../src/api.js';
import {SourceCatalog} from '../src/plugins/sources/SourceCatalog.js';
import {Sources} from '../src/plugins/sources/Sources.js';
import {pages as sourcePages,connectionsPages} from '../src/plugins/sources/index.js';
import {webFeatures} from '../src/features/registry.js';
import {resources} from '../src/resource-cache.js';

function fakeNotion(){
 const calls:{path:string;method:string}[]=[];
 const state={workspace:'generated-workspace-A',failRead:false};
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const transport:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input)),method=init.method??'GET';calls.push({path:url.pathname,method});
  if(url.hostname!=='api.notion.com')throw Error('No unbounded provider network in the generated official connector fixture');
  if(url.pathname==='/v1/oauth/token')return json({access_token:'generated-private-notion-token',workspace_id:state.workspace,workspace_name:state.workspace,bot_id:'generated-bot'});
  if(state.failRead)return json({code:'unauthorized'},401);
  if(url.pathname==='/v1/search')return json({results:[{object:'page',id:'page-generated',url:'https://www.notion.so/page-generated',properties:{Name:{type:'title',title:[{plain_text:'Generated selected page'}]}}}],has_more:false});
  if(url.pathname==='/v1/pages/page-generated')return json({object:'page',id:'page-generated',url:'https://www.notion.so/page-generated',created_time:'2026-01-01T00:00:00Z',last_edited_time:'2026-11-01T00:00:00Z',properties:{Name:{type:'title',title:[{plain_text:'Generated selected page'}]}}});
  if(url.pathname==='/v1/blocks/page-generated/children')return json({results:[{id:'generated-block',object:'block',type:'paragraph',paragraph:{rich_text:[{plain_text:'Generated actual Notion body through owner HTTP and rendered source settings'}]}}],has_more:false,next_cursor:null});
  throw Error('Unexpected generated Notion request '+url.pathname);
 };
 return {transport,calls,state};
}
function Flow({api}:{api:Api}){
 const [hash,setHash]=useState(window.location.hash);
 useEffect(()=>{const changed=()=>setHash(window.location.hash);window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 return hash.startsWith('#/connections/add')?React.createElement(SourceCatalog,{api,onPage:()=>{}}):React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}});
}
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-official-flow-')),owner='generated-owner-'+randomUUID(),secret='GENERATED_NOTION_'+randomUUID().replaceAll('-','_'),provider=fakeNotion();process.env[secret]='generated-private-client-secret';
 const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:64*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
 const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{fetch:provider.transport,lark:async()=>{throw Error('No CLI belongs in the Notion flow');}},agent:{configured:false,async query(){throw Error('No model in the official connector flow');},async close(){}}});
 const origin=await node.app.listen({host:'127.0.0.1',port:0}),nativeFetch=globalThis.fetch,prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:origin+'/#/connections/add',pretendToBeVisual:true});
 const requests:{path:string;method:string}[]=[];
 const ownerFetch:typeof fetch=async(input,init={})=>{assert.equal(typeof input,'string');assert.ok(String(input).startsWith('/api/'));requests.push({path:String(input),method:init.method??'GET'});assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+owner);return nativeFetch(new URL(String(input),origin),init);};
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,fetch:ownerFetch})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const api=createApi({token:owner}),root=createRoot(dom.window.document.getElementById('root')!);
 const local=await webFeatures.install({id:'generated.official-flow',version:'1',components:[]},[...sourcePages,...connectionsPages].map(entry=>({surface:'page' as const,entry})));
 t.after(async()=>{await act(async()=>root.unmount());await local.dispose();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}configureLocale(()=>locale);dom.window.close();await node.app.close();delete process.env[secret];await rm(directory,{recursive:true,force:true});});
 const until=async(check:()=>boolean|Promise<boolean>)=>{for(let attempt=0;attempt<800;attempt++){if(await check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));}throw Error('The generated official source flow did not settle');};
 const request=<T=any>(path:string,body?:unknown)=>api.request<T>(path,body===undefined?undefined:{method:'POST',body:JSON.stringify(body)});
 const preview=await request('/api/plugins/resolve',{repository:'mote/official-notion-connector',tag:'v0.1.0'});await request('/api/plugins/install',{previewId:preview.id,expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});await until(()=>node.pluginCenter.view().packages[0]?.state==='installed');
 const installed=await request('/api/plugins'),packageId=installed.packages.find((item:any)=>item.source.repository==='mote/official-notion-connector').id;
 const instance=await request('/api/plugin-instances',{packageId,name:'Generated Notion flow',scope:'default',configuration:{clientId:'generated-client',clientSecret:'${'+secret+'}',redirectUri:'https://central.example/oauth/notion/callback'},expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});
 await request('/api/plugin-instances/'+instance.id+'/check',{expectedRevision:instance.revision,operationId:randomUUID()});await until(()=>node.pluginCenter.instanceView(instance.id).observed==='ready');await request('/api/plugin-instances/'+instance.id+'/enable',{expectedRevision:node.pluginCenter.instanceView(instance.id).revision,operationId:randomUUID()});await until(()=>node.pluginCenter.instanceView(instance.id).desired&&node.pluginCenter.instanceView(instance.id).observed==='ready');
 const button=(title:string)=>{const value=[...dom.window.document.querySelectorAll('button')].find(value=>value.textContent===title);assert.ok(value,'Missing button '+title);return value;};
 const click=async(title:string)=>act(async()=>{button(title).click();});
 const render=()=>act(async()=>root.render(React.createElement(Flow,{api})));
 return {node,dom,api,provider,requests,request,until,button,click,render,instance,
  async refresh(){await act(async()=>resources(api).invalidate(key=>key.startsWith('/api/connectors/')||key==='/api/sources'));},
  async authorize(){await click('连接账号');await until(()=>Boolean(dom.window.document.querySelector('.connector-authorization')));const target=new URL(dom.window.document.querySelector<HTMLAnchorElement>('.connector-authorization')!.href);assert.equal(target.hostname,'api.notion.com');assert.equal(target.searchParams.has('access_token'),false);const callback=await nativeFetch(origin+'/oauth/notion/callback?state='+encodeURIComponent(target.searchParams.get('state')!)+'&code=generated-code');assert.equal(callback.status,200);await this.refresh();await until(()=>Boolean([...dom.window.document.querySelectorAll('button')].find(value=>value.textContent==='读取可选内容')));},
  assertPrivate(){const html=dom.window.document.documentElement.outerHTML;for(const secret of [owner,'generated-private-notion-token','generated-private-client-secret'])assert.equal(html.includes(secret),false);assert.ok(requests.every(value=>!value.path.includes(owner)));},
 };
}

test('Notion directory opens the formal installed connector, authorizes, saves a scope, syncs and revisits source settings over owner HTTP',async t=>{
 const f=await fixture(t);await f.render();await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent?.startsWith('Notion'))));
 const card=[...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent?.startsWith('Notion'))!.closest<HTMLAnchorElement>('a')!;assert.equal(new URL(card.href).hash,'#/connections?setup=official-notion');await act(async()=>card.click());await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('button')].find(value=>value.textContent==='连接账号')));
 await f.authorize();await f.click('读取可选内容');await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('label')].find(value=>value.textContent?.includes('Generated selected page'))));
 const checkbox=f.dom.window.document.querySelector<HTMLInputElement>('.official-source-connector input[type=checkbox]')!;await act(async()=>checkbox.click());await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(source=>source.kind==='mote.official.notion'&&source.status?.coverage?.state==='complete'));await f.refresh();await f.until(()=>f.dom.window.document.body.textContent!.includes('所选范围已完成'));
 const source=f.node.sources.listSources().find(value=>value.kind==='mote.official.notion')!;assert.equal(source.initialSync,'all');assert.match(f.node.sources.getItem(source.id,'page-generated')!.text,/actual Notion body/);assert.equal(source.status?.coverage?.processed,1);
 const detail=f.dom.window.document.querySelector<HTMLAnchorElement>('a[href="#/connections?sourceId='+source.id+'"]')!;await act(async()=>detail.click());await f.until(()=>Boolean(f.dom.window.document.querySelector('.source-final-tabs')));await act(async()=>f.dom.window.document.querySelector<HTMLButtonElement>('.source-final-tabs button:last-child')!.click());await f.until(()=>Boolean(f.dom.window.document.querySelector('[data-official-provider=notion]')));assert.match(f.dom.window.document.body.textContent!,/generated-workspace-A/);assert.equal(f.node.sources.history(source.id,'page-generated').length,1);f.assertPrivate();
});
