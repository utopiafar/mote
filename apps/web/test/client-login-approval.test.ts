import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import {ApiError,type Api} from '../src/api.js';
import {ClientLoginApproval,type ClientLoginOutcome} from '../src/plugins/agent-access/ClientLoginApproval.js';

configureLocale(()=> 'zh-CN');

async function fixture(t: import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-client-login-approval-')),token='generated-client-login-'+randomUUID();
  const node=await buildApp({
    dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,
    maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',
  },{
    backgroundWorker:false,
    agent:{configured:false,query:async()=>{throw Error('No model in generated login approval fixture');},close:async()=>{}},
  });
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {node,token};
}

function browser(t: import('node:test').TestContext){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {root,document:dom.window.document};
}

function client(node:Awaited<ReturnType<typeof buildApp>>,token:string):Api{
  return {
    request:async <T>(path:string,init:RequestInit={}):Promise<T>=>{
      const method=(init.method??'GET').toUpperCase(),headers=new Headers(init.headers);
      headers.set('authorization','Bearer '+token);
      if(typeof init.body==='string'&&!headers.has('content-type'))headers.set('content-type','application/json');
      const response=await node.app.inject({method:method as 'GET'|'POST'|'PUT'|'DELETE',url:path,headers:Object.fromEntries(headers),...(typeof init.body==='string'?{payload:init.body}:{})});
      if(response.statusCode>=400)throw new ApiError(response.body||`HTTP ${response.statusCode}`,response.statusCode);
      return (response.body?JSON.parse(response.body):undefined) as T;
    },
    setAgentTimeout:()=>{},
  } as Api;
}

const until=async(check:()=>boolean,label:string)=>{
  for(let i=0;i<300&&!check();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  assert.ok(check(),label);
};

async function createRequest(node:Awaited<ReturnType<typeof buildApp>>,deviceName:string,verifier:string){
  const response=await node.app.inject({method:'POST',url:'/api/login/requests',payload:{serverUrl:'https://fixture.invalid',deviceId:deviceName.toLowerCase().replaceAll(' ','-'),deviceName,platform:'android',challenge:createHash('sha256').update(verifier).digest('hex')}});
  assert.equal(response.statusCode,200,response.body);
  return (response.json() as {id:string}).id;
}

async function poll(node:Awaited<ReturnType<typeof buildApp>>,id:string,verifier:string){
  return node.app.inject({method:'POST',url:'/api/login/poll',payload:{id,verifier}});
}

test('a real approval and rejection each act on exactly their own login request',async t=>{
  const {node,token}=await fixture(t),b=await browser(t),api=client(node,token);
  const verifierA=randomBytes(32).toString('base64url'),verifierB=randomBytes(32).toString('base64url');
  const idA=await createRequest(node,'Generated Login A',verifierA),idB=await createRequest(node,'Generated Login B',verifierB);
  const outcomes:ClientLoginOutcome[]=[];
  await act(async()=>b.root.render(React.createElement(ClientLoginApproval,{id:idA,api,done:outcome=>outcomes.push(outcome)})));
  const action=(label:string)=>Array.from(b.document.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent===label);
  await until(()=>Boolean(action('继续登录客户端')&&!action('继续登录客户端')!.disabled),'request A detail');
  await act(async()=>action('继续登录客户端')!.click());
  await until(()=>outcomes.length===1,'approval outcome');
  assert.deepEqual(outcomes,['approved']);
  const granted=await poll(node,idA,verifierA);assert.equal(granted.statusCode,200,granted.body);assert.equal((granted.json() as {ready:boolean}).ready,true);
  const pending=await poll(node,idB,verifierB);assert.equal(pending.statusCode,200,pending.body);assert.deepEqual(pending.json(),{ready:false});

  await act(async()=>b.root.render(React.createElement(ClientLoginApproval,{id:idB,api,done:outcome=>outcomes.push(outcome)})));
  await until(()=>Boolean(action('拒绝这次登录')&&!action('拒绝这次登录')!.disabled),'request B detail');
  await act(async()=>action('拒绝这次登录')!.click());
  await until(()=>outcomes.length===2,'rejection outcome');
  assert.deepEqual(outcomes,['approved','rejected']);
  const rejected=await poll(node,idB,verifierB);assert.equal(rejected.statusCode,410,rejected.body);
  assert.equal(((await poll(node,idA,verifierA)).json() as {ready:boolean}).ready,true,'rejecting B leaves the approved A grant intact');
});
