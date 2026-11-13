import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {buildApp} from '../../../server/src/app.js';
import {parseFunasrArchive,parseFunasrRequest,parseFunasrResponse,projectFunasrDiarization,funasrTranscriptOutput,funasrDialogueOutput,type FunasrSuccess} from '../../../server/src/funasr-contract.js';
import {authorizeFixtureModels} from '../../../server/test/fixtures/model-authorization.js';
import {ApiError,type Api} from '../../src/api.js';

export function deferred<T=unknown>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
export async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'Generated audio view did not settle');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});}}

export async function audioDom(t:TestContext){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 dom.window.localStorage.setItem('mote.language','zh-CN');
 const stopped:HTMLMediaElement[]=[],played:HTMLMediaElement[]=[];
 dom.window.HTMLMediaElement.prototype.pause=function(){stopped.push(this);};dom.window.HTMLMediaElement.prototype.load=()=>{};dom.window.HTMLMediaElement.prototype.play=async function(){played.push(this);};
 const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL,urls:string[]=[],revoked:string[]=[];
 URL.createObjectURL=()=>{const url='blob:generated-audio-'+urls.length;urls.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);};
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document;
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const render=async(element:React.ReactNode)=>act(async()=>{root.render(element);});
 const button=(label:string)=>{const value=[...d.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);assert.ok(value,'Missing button: '+label);return value;};
 const click=async(label:string)=>act(async()=>button(label).click());
 const input=async(element:HTMLInputElement,value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 return {dom,d,root,render,button,click,input,stopped,played,urls,revoked};
}

/** Current production Python serializer -> registry -> actual durable pipeline,
 * archive ingress, SQLite and authenticated route serializers -> Web reader.
 * Only model computation and the not-yet-merged default ASR-03 recipe assembly
 * are generated boundaries. This does not claim the default worker is wired. */
export async function audioCentral(t:TestContext,options:{mediaWorker?:{endpoint:string;token:string}}={}){
 const producer=spawnSync('python3',[fileURLToPath(new URL('../../../../scripts/test_mote_asr_contract.py',import.meta.url)),'--emit'],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:30000});
 assert.equal(producer.status,0,producer.stderr||String(producer.error));const bundle=JSON.parse(producer.stdout);
 const directory=await mkdtemp(join(tmpdir(),'mote-funasr-ui-')),token='generated-audio-owner-'+randomUUID();
 const node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:4_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',...(options.mediaWorker?{media:{modelDirectory:join(directory,'models'),workerToken:options.mediaWorker.token,asrEndpoint:options.mediaWorker.endpoint,ocrEndpoint:options.mediaWorker.endpoint,asrPort:Number(new URL(options.mediaWorker.endpoint).port),ocrPort:Number(new URL(options.mediaWorker.endpoint).port),python:'python3'}}:{})},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 await authorizeFixtureModels(node);
 const runtime=node.processing.runtime;
 for(const output of [funasrTranscriptOutput,funasrDialogueOutput])if(!runtime.outputs.list().some(value=>value.id===output.id&&value.version===output.version))runtime.outputs.register(output);
 let scenario:'dialogue'|'failed'|'missing'|'empty'='dialogue';
 let held:{started:ReturnType<typeof deferred<void>>;released:ReturnType<typeof deferred<void>>}|undefined;
 const current=()=>scenario==='empty'?bundle.empty[1]:bundle;
 const recognition=()=>parseFunasrResponse(current().response,parseFunasrRequest(current().request)) as FunasrSuccess;
 const diarization=()=>{const result=parseFunasrResponse(current().diarizeResponse,parseFunasrRequest(current().diarizeRequest));assert.ok(result.status==='succeeded'&&result.operation==='diarize');return result;};
 runtime.registry.register({id:'fixture.funasr-reader',version:'1',name:'Generated FunASR boundary',stage:'extract',mediaTypes:['audio/'],dialogue:true,localOnly:true,output:funasrTranscriptOutput,recipe:{id:'fixture.funasr-reader',version:'1'},process:async()=>recognition()});
 runtime.registry.register({id:'fixture.cam-reader',version:'1',name:'Generated CAM boundary',stage:'diarize',mediaTypes:['audio/'],localOnly:true,process:async()=>{
  if(held){const gate=held;held=undefined;gate.started.resolve();await gate.released.promise;}
  if(scenario==='failed'||scenario==='missing')throw new ProviderFailure({category:scenario==='missing'?'blocked':'permanent',code:scenario==='missing'?'model_missing':'generated_cam_failed'});
  const response=diarization();return projectFunasrDiarization(parseFunasrArchive(response.checkpoint),response.diarization);
 }});
 runtime.recipes.registerStage({id:'fixture.funasr-project',version:'1',run:context=>context.transform(funasrDialogueOutput,async()=>diarization())});
 runtime.recipes.registerRecipe({id:'fixture.funasr-reader',version:'1',steps:[{name:'extract',stage:{id:'mote.extract',version:'1'},dependsOn:[]},{name:'diarize',stage:{id:'mote.diarize',version:'1'},dependsOn:['extract']},{name:'align',stage:{id:'fixture.funasr-project',version:'1'},dependsOn:['extract','diarize']}],output:'align'});
 const view=node.processing.view(),policy=structuredClone(view.policy);
 policy.profiles.push({id:'fixture.funasr-reader',name:'Generated reader recipe',processorId:'fixture.funasr-reader',diarizationProcessor:'fixture.cam-reader',parameters:{},summarize:false});policy.rules.unshift({type:'audio/wav',profileId:'fixture.funasr-reader'});
 await node.processing.save({revision:view.revision,settings:node.processing.currentSettings(),policy});
 node.sources.register({id:'generated-audio-ui',name:'Generated audio UI',kind:'upload',deviceId:'generated-audio',platform:'import',retention:'archive'});
 const calls:{path:string;init:RequestInit}[]=[],responses:{path:string;body:string}[]=[];
 const raw=async(path:string,init:RequestInit={})=>{
  init.signal?.throwIfAborted();calls.push({path,init});
  const response=await node.app.inject({method:(init.method??'GET') as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:path,headers:{authorization:'Bearer '+token,...(typeof init.body==='string'?{'content-type':'application/json'}:{})},...(typeof init.body==='string'?{payload:init.body}:{})});
  init.signal?.throwIfAborted();responses.push({path,body:response.body});
  if(response.statusCode>=400)throw new ApiError(response.body,response.statusCode);
  return new Response(response.rawPayload,{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,value])=>typeof value==='string')) as Record<string,string>});
 };
 const api={raw,request:async<T>(path:string,init?:RequestInit):Promise<T>=>JSON.parse(await(await raw(path,init)).text())} as Api;
 const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
 async function upload(value:typeof scenario='dialogue',process=true){
  scenario=value;const start=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers:{authorization:'Bearer '+token},payload:{sourceId:'generated-audio-ui',item:{externalId:randomUUID()+'.wav',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated '+value+' recording',text:'',kind:'file',layer:'original',mimeType:'audio/wav'},sha256:bundle.source.audioSha256,sizeBytes:wav.length}});
  assert.equal(start.statusCode,200,start.body);let ack=start.json().ack;
  if(!ack){const part=await node.app.inject({method:'PUT',url:'/api/file-sync/v1/uploads/'+start.json().uploadId+'/parts/0',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream'},payload:wav});assert.equal(part.statusCode,200,part.body);const commit=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads/'+start.json().uploadId+'/commit',headers:{authorization:'Bearer '+token},payload:{}});assert.equal(commit.statusCode,200,commit.body);ack=commit.json();}
  if(process)await node.processing.tick();return String(ack.id);
 }
 return {node,api,token,bundle,directory,calls,responses,upload,holdDiarization(){assert.equal(held,undefined);const gate={started:deferred<void>(),released:deferred<void>()};held=gate;t.after(()=>gate.released.resolve());return {started:gate.started.promise,release:()=>gate.released.resolve()};}};
}
