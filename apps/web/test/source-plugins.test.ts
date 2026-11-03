import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import type {FeatureInventory,RecordingStatus,SourceConnection} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import type {RecordingProvider} from '../../server/src/connectors/recordings.js';
import type {Api} from '../src/api.js';
import {webFeatures} from '../src/features/registry.js';
import type {PageEntry,PageProps} from '../src/features/types.js';
import {connectionsPages,pages as sourcePages} from '../src/plugins/sources/index.js';
import {
  sourcePluginBound,
  sourcePluginFor,
  sourcePluginStateLabel,
  sourcePluginStatus,
  sourcePlugins,
} from '../src/plugins/sources/index.js';

async function settle(check:()=>boolean){
  for(let attempt=0;attempt<80&&!check();attempt++)await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
  assert.ok(check(),'the generated source plugin route did not settle');
}

const source=(id:string,kind:string,enabled=true)=>({id,name:`Generated ${kind}`,kind,deviceId:id,platform:'import',retention:'snapshot',enabled});

test('the source catalog consumes the real connector response for every source plugin',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-source-plugins-'));
  const readToken='generated-mcp-read-secret-reference',writeToken='generated-mcp-write-secret-reference';
  const config:Config={dataDir:join(directory,'vault'),token:'generated-source-plugins-owner-token',tokenPath:'generated-fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:readToken,mcpWriteEnabled:true,mcpWriteToken:writeToken,mcpWriteSourceIds:['generated-mcp']}};
  const providerCalls:string[]=[],modelCalls:string[]=[],cliCalls:string[]=[];
  const providerFixture=(id:string):RecordingProvider=>{
    const unused=async(method:string):Promise<never>=>{providerCalls.push(id+':'+method);throw Error('No provider work belongs in generated source-plugin fixtures');};
    return {id,version:'generated-fixture@1',account:()=>unused('account'),discover:()=>unused('discover'),metadata:()=>unused('metadata'),transcript:()=>unused('transcript'),media:()=>unused('media')};
  };
  let node:Awaited<ReturnType<typeof buildApp>>|undefined,root:ReturnType<typeof createRoot>|undefined,dom:JSDOM|undefined,local:Awaited<ReturnType<typeof webFeatures.install>>|undefined;
  const previousLocale=getLocale(),previous=new Map<string,PropertyDescriptor|undefined>();
  t.after(async()=>{
    if(root)await act(async()=>root!.unmount());
    await local?.dispose();
    for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
    configureLocale(()=>previousLocale);
    dom?.window.close();
    await node?.app.close();
    await rm(directory,{recursive:true,force:true});
  });
  node=await buildApp(config,{
    backgroundWorker:false,
    connectorTesting:{recordings:[providerFixture('feishu'),providerFixture('dingtalk')],lark:async()=>{cliCalls.push('lark');throw Error('No CLI invocation belongs in generated source-plugin fixtures');}},
    agent:{configured:false,query:async()=>{modelCalls.push('query');throw Error('No model is authorized for generated source-plugin fixtures');},close:async()=>{}},
  });
  await node.app.ready();
  const headers={authorization:'Bearer '+config.token};
  for(const item of [source('generated-gmail','gmail',false),source('generated-google','google-calendar'),source('generated-lark','lark-docs'),source('generated-recording','feishu.recordings'),source('generated-mcp','mcp')]){
    const created=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:item});
    assert.equal(created.statusCode,200,created.body);
  }
  const requests:{method:string;path:string;status:number}[]=[];
  const api={request:async<T>(path:string,init?:RequestInit):Promise<T>=>{
    const method=(init?.method??'GET').toUpperCase(),record={method,path,status:0};
    requests.push(record);
    const response=await node!.app.inject({method:method as 'GET',url:path,headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
    record.status=response.statusCode;
    assert.equal(response.statusCode,200,path+' '+response.body);
    return response.json() as T;
  },setAgentTimeout:()=>{}} as Api;
  const inventory=await api.request<FeatureInventory>('/api/features');
  const connectorStatuses=await api.request<Record<string,unknown>>('/api/connectors/status');
  const larkStatus=await api.request<Record<string,unknown>>('/api/connectors/lark');
  const statuses={...connectorStatuses,lark:larkStatus};
  const sources=(await api.request<{items:SourceConnection[]}>('/api/sources')).items;
  assert.ok(inventory.capabilities.some(capability=>capability.id==='connector:feishu-recordings'));
  assert.equal(JSON.stringify(connectorStatuses).includes(readToken),false,'a status exposes only the configured reference, never the MCP read secret');
  assert.equal(JSON.stringify(connectorStatuses).includes(writeToken),false,'a status exposes only the configured reference, never the MCP write secret');
  assert.equal((connectorStatuses.mcp as {readConfigured?:boolean}).readConfigured,true);
  assert.deepEqual((connectorStatuses.mcp as {writeSourceIds?:string[]}).writeSourceIds,['generated-mcp']);

  const gmail=sourcePlugins.find(plugin=>plugin.id==='mote.connector.gmail')!;
  const google=sourcePlugins.find(plugin=>plugin.id==='mote.connector.google-calendar')!;
  const lark=sourcePlugins.find(plugin=>plugin.id==='mote.connector.lark')!;
  for(const plugin of [gmail,google,lark]){
    assert.ok(sourcePluginStatus(plugin,statuses),plugin.id+' has a real connector status');
    assert.equal(sourcePluginBound(plugin,sources.find(item=>plugin.kinds.includes(item.kind))!,statuses),false,'an unauthenticated account is not a valid binding');
  }
  assert.equal(sourcePluginStateLabel(gmail,{catalog:statuses,sources}),'已暂停');
  assert.equal(sourcePluginStateLabel(google,{catalog:statuses,sources}),'尚未授权');
  assert.equal(sourcePluginStateLabel(lark,{catalog:statuses,sources}),'尚未授权');
  assert.equal(sourcePluginFor(sources.find(item=>item.kind==='gmail')!,statuses)?.id,'mote.connector.gmail');
  assert.equal(sourcePluginFor(sources.find(item=>item.kind==='lark-docs')!,statuses)?.id,'mote.connector.lark');
  assert.equal(sourcePluginFor(sources.find(item=>item.kind==='feishu.recordings')!,statuses)?.id,'mote.connector.feishu-recordings');

  local=await webFeatures.install({id:'generated.source-plugins',version:'1',components:[]},[...sourcePages,...connectionsPages].map(entry=>({surface:'page' as const,entry})));
  const catalogEntry=sourcePages.find(page=>page.id==='sourceCatalog')!;
  dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/'+catalogEntry.route,pretendToBeVisual:true});
  configureLocale(()=>'zh-CN');
  for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  root=createRoot(dom.window.document.getElementById('root')!);
  const props:PageProps={api,status:null,devices:[],activity:{apps:[],devices:[],totalDurationMs:0,captures:0},recent:[],insights:[],onPage:()=>{},onOpen:()=>{},range:{},archiveTab:'materials',setArchiveTab:()=>{},timelineRevision:0,refresh:()=>{},disconnect:()=>{},sessionLifetime:'session',changeSessionLifetime:()=>{}};
  await act(async()=>root!.render(React.createElement(React.Suspense,{fallback:'Generated route loading'},catalogEntry.render(props))));
  await settle(()=>Array.from(dom!.window.document.querySelectorAll('h3')).some(heading=>heading.textContent==='Gmail 邮件'));
  const cardState=(title:string)=>{
    const heading=Array.from(dom!.window.document.querySelectorAll('h3')).find(element=>element.textContent===title);
    assert.ok(heading,title);
    return heading.closest('.discovery-source-card')!.querySelector('.catalog-state')?.textContent;
  };
  assert.equal(cardState('Gmail 邮件'),'已暂停');
  assert.equal(cardState('Google Calendar'),'尚未授权');
  assert.equal(cardState('飞书文档与日历'),'尚未授权');
  assert.equal(cardState('MCP 资料服务'),'选择可读资源导入');
  assert.equal(dom.window.document.body.textContent!.includes(readToken),false);
  assert.equal(dom.window.document.body.textContent!.includes(writeToken),false);
  assert.ok(requests.every(request=>request.status===200));
  assert.deepEqual(providerCalls,[]);
  assert.deepEqual(cliCalls,[]);
  assert.deepEqual(modelCalls,[]);
});
