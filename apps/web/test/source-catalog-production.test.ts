import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import type {FeatureInventory,RecordingStatus} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import type {RecordingProvider} from '../../server/src/connectors/recordings.js';
import {recordingManifest} from '../../server/src/plugins/recording-sources.js';
import type {Api} from '../src/api.js';
import {pages as sourcePages} from '../src/plugins/sources/index.js';
import {webFeatures} from '../src/features/registry.js';
import type {PageEntry,PageProps} from '../src/features/types.js';

async function settle(check:()=>boolean){
  for(let attempt=0;attempt<80&&!check();attempt++)await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
  assert.ok(check(),'the generated production route did not settle');
}

test('production connector inventory opens built-in and third-party recording cards through the real owner GET routes without account or provider work',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-source-catalog-production-'));
  const generatedProviderCalls:string[]=[];
  const generatedUnused=async(method:string):Promise<never>=>{generatedProviderCalls.push(method);throw Error('No provider work belongs in generated discovery fixtures');};
  const connectorManifest=recordingManifest('generated',()=>({
    id:'generated',version:'generated-fixture@1',
    account:()=>generatedUnused('account'),discover:()=>generatedUnused('discover'),metadata:()=>generatedUnused('metadata'),
    transcript:()=>generatedUnused('transcript'),media:()=>generatedUnused('media'),
  }),{label:'Generated third-party recorder',setup:{description:'Generated setup fixture only'}});
  const config:Config={dataDir:join(directory,'vault'),token:'generated-source-catalog-owner-token',tokenPath:'generated-fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors')}};
  const providerCalls:string[]=[],modelCalls:string[]=[],cliCalls:string[]=[];
  const providerFixture=(id:string):RecordingProvider=>{
    const unused=async(method:string):Promise<never>=>{providerCalls.push(id+':'+method);throw Error('No account or provider reads belong in generated discovery fixtures');};
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
    connectorManifests:[connectorManifest],
    connectorTesting:{recordings:[providerFixture('feishu'),providerFixture('dingtalk')],lark:async()=>{cliCalls.push('lark');throw Error('No CLI invocation belongs in generated discovery fixtures');}},
    agent:{configured:false,query:async()=>{modelCalls.push('query');throw Error('No model is authorized for generated discovery fixtures');},close:async()=>{}},
  });
  await node.app.ready();
  const requests:{method:string;path:string;status:number}[]=[],navigation:string[]=[];
  const api={request:async<T>(path:string,init?:RequestInit):Promise<T>=>{
    const method=(init?.method??'GET').toUpperCase(),record={method,path,status:0};
    requests.push(record);
    assert.equal(method,'GET','discovery and navigation cannot mutate a connector');
    const response=await node!.app.inject({method:'GET',url:path,headers:{authorization:'Bearer '+config.token}});
    record.status=response.statusCode;
    assert.equal(response.statusCode,200,path+' '+response.body);
    return response.json() as T;
  },setAgentTimeout:()=>{}} as Api;
  const featureInventory=await api.request<FeatureInventory>('/api/features');
  const statuses=await api.request<Record<string,RecordingStatus>>('/api/connectors/status');
  for(const provider of ['feishu','dingtalk','generated']){
    const connector=featureInventory.capabilities.find(capability=>capability.id==='connector:'+provider+'-recordings');
    assert.ok(connector,provider);
    assert.equal(connector.version,'1');
    assert.equal(connector.surface,'ingress');
    assert.equal(connector.state,'active');
    assert.equal(statuses[provider+'-recordings']?.provider,provider);
    assert.equal(statuses[provider+'-recordings']?.category,'recordings');
    assert.equal(featureInventory.capabilities.some(capability=>capability.id==='http:GET:/api/connectors/'+provider+'-recordings'),false,'ConnectorRegistry does not advertise individual HTTP capabilities');
  }
  assert.equal(featureInventory.capabilities.some(capability=>capability.id==='http:GET:/api/connectors/status'),false,'the globally mounted status route is outside ServerFeatureHost HTTP inventory');
  const catalogEntry=sourcePages.find(page=>page.id==='sourceCatalog'),recordingsEntry=sourcePages.find(page=>page.id==='recordings');
  assert.ok(catalogEntry);assert.ok(recordingsEntry);
  local=await webFeatures.install({id:catalogEntry.featureId,version:'1',components:[]},[catalogEntry,recordingsEntry].map(entry=>({surface:'page' as const,entry})));
  dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/'+catalogEntry.route,pretendToBeVisual:true});
  configureLocale(()=>'zh-CN');
  for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  root=createRoot(dom.window.document.getElementById('root')!);
  const props:PageProps={api,status:null,devices:[],activity:{apps:[],devices:[],totalDurationMs:0,captures:0},recent:[],insights:[],onPage:page=>navigation.push(page),onOpen:()=>{},range:{},archiveTab:'materials',setArchiveTab:()=>{},timelineRevision:0,refresh:()=>{},disconnect:()=>{},sessionLifetime:'session',changeSessionLifetime:()=>{}};
  const render=async(entry:PageEntry)=>{await act(async()=>root!.render(React.createElement(React.Suspense,{fallback:'Generated route loading'},entry.render(props))));};
  const providerLink=(provider:string)=>Array.from(dom!.window.document.querySelectorAll<HTMLAnchorElement>('.discovery-source-catalog a[href]')).find(link=>new URLSearchParams(link.hash.split('?')[1]).get('provider')===provider);
  for(const provider of ['feishu','dingtalk','generated']){
    await act(async()=>{location.hash='#/'+catalogEntry.route;});
    await render(catalogEntry);
    await settle(()=>Boolean(dom!.window.document.querySelector<HTMLButtonElement>('.source-catalog-final button.discovery-source-card:not(:disabled)')));
    await act(async()=>dom!.window.document.querySelector<HTMLButtonElement>('.source-catalog-final button.discovery-source-card')!.click());
    await settle(()=>Boolean(providerLink(provider)));
    const link=providerLink(provider)!;
    assert.equal(link.getAttribute('href'),'#/'+recordingsEntry.route+'?provider='+provider);
    assert.equal(link.getAttribute('aria-disabled'),null);
    if(provider==='generated')assert.match(link.textContent!,/Generated third-party recorder/);
    await act(async()=>link.click());
    assert.equal(location.hash,'#/'+recordingsEntry.route+'?provider='+provider);
    await render(recordingsEntry);
    const detailPath='/api/connectors/'+provider+'-recordings';
    await settle(()=>requests.some(request=>request.path===detailPath&&request.status===200));
    assert.equal(dom.window.document.querySelector('[role="alert"]'),null);
  }
  assert.deepEqual(navigation,[],'provider links preserve their query rather than invoke a fallback page callback');
  assert.ok(requests.every(request=>request.method==='GET'&&request.status===200));
  assert.deepEqual(providerCalls,[]);
  assert.deepEqual(generatedProviderCalls,[]);
  assert.deepEqual(cliCalls,[]);
  assert.deepEqual(modelCalls,[]);
});
