import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import {materialId,type MaterialDraft} from '../../server/src/materials.js';
import {ApiError,type Api} from '../src/api.js';
import {ReferenceDetail} from '../src/plugins/reader/index.js';

configureLocale(()=> 'zh-CN');

async function fixture(t: import('node:test').TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'mote-plugin-reader-contract-')),token='generated-plugin-reader-'+randomUUID();
  const node=await buildApp({
    dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,
    maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',
  },{
    backgroundWorker:false,
    agent:{configured:false,query:async()=>{throw Error('No model in generated reader contract fixture');},close:async()=>{}},
  });
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {node,token};
}

function apiFor(node:Awaited<ReturnType<typeof buildApp>>,token:string){
  const calls:string[]=[];
  const request=async <T>(path:string,init:RequestInit={}):Promise<T>=>{
    calls.push(path);
    const method=(init.method??'GET').toUpperCase(),headers=new Headers(init.headers);
    headers.set('authorization','Bearer '+token);
    if(typeof init.body==='string'&&!headers.has('content-type'))headers.set('content-type','application/json');
    const response=await node.app.inject({
      method:method as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:path,headers:Object.fromEntries(headers),
      ...(typeof init.body==='string'?{payload:init.body}:{}),
    });
    if(response.statusCode>=400)throw new ApiError(response.body||`HTTP ${response.statusCode}`,response.statusCode);
    return (response.body?JSON.parse(response.body):undefined) as T;
  };
  return {api:{request,setAgentTimeout:()=>{}} as Api,calls};
}

async function renderReference(t:import('node:test').TestContext,api:Api,reference:string){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  const root=createRoot(dom.window.document.querySelector('#root')!);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated reader did not settle');};
  await act(async()=>root.render(React.createElement(ReferenceDetail,{api,reference,onOpen:()=>{}})));
  return {document:dom.window.document,root,until};
}

test('the reader consumes a real pinned Material response with its exact revision and page range',async t=>{
  const {node,token}=await fixture(t),{api,calls}=apiFor(node,token),sourceId='generated-reader-contract';
  const body='Generated first page range.\n'.repeat(220),nextBody='Generated next page range.';
  const base:MaterialDraft={
    id:materialId(sourceId,'item'),kind:'mote.note',schemaVersion:1,title:'Generated pinned reader contract',
    origin:{sourceId,externalId:'item',deviceId:'generated-device'},
    blocks:[{id:'body',kind:'text',format:'plain',text:body,memberIds:[]}],members:[],
    coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'},
  };
  const first=node.materials.publish(base),second=node.materials.publish({...base,blocks:[{...base.blocks[0]!,text:body+nextBody}]},{expectedRevision:first.revision});
  assert.notEqual(first.revision,second.revision);

  const {document:d,until}=await renderReference(t,api,first.ref);
  await until(()=>d.body.textContent!.includes('Generated first page range.'));
  assert.doesNotMatch(d.querySelector('.library-detail')?.textContent??d.body.textContent!,/Generated next page range/);
  assert.ok(calls.includes(`/api/materials/${first.id}/revisions/${first.revision}`),'metadata reads the pinned revision');
  const firstRead=calls.find(path=>path.startsWith(`/api/materials/${first.id}/read?`))!;
  assert.ok(firstRead,'the body uses the real Material read route');
  const query=new URLSearchParams(firstRead.split('?')[1]);
  assert.equal(query.get('revision'),first.revision);
  assert.equal(query.get('offset'),'0');
  assert.equal(query.get('length'),'4000');

  await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='继续展开')!.click());
  await until(()=>calls.some(path=>path.startsWith(`/api/materials/${first.id}/read?`)&&new URLSearchParams(path.split('?')[1]).get('offset')==='4000'));
  const nextRead=calls.filter(path=>path.startsWith(`/api/materials/${first.id}/read?`)).at(-1)!;
  const nextQuery=new URLSearchParams(nextRead.split('?')[1]);
  assert.equal(nextQuery.get('revision'),first.revision,'continuation keeps the same pinned revision');
  assert.equal(nextQuery.get('offset'),'4000');
  assert.equal(nextQuery.get('length'),'4000');
});
