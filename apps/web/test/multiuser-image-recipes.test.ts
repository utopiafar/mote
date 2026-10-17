import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {scopedFilesFixture} from '../../server/test/fixtures/scoped-files.js';
import {waitForScopedState} from '../../server/test/fixtures/scoped-process.js';
import {defaultModelSettings} from '../../server/src/model-settings.js';
import {FileDetail} from '../src/Files.js';
import {createApi,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {configureLocale} from '@mote/shared/i18n';
configureLocale(()=> 'zh-CN');

for(const mode of ['ocr','no-ocr','partial','double-ocr'] as const)test(`original Files consumes typed custom recipe: ${mode}`,async t=>{
 const withOcr=mode!=='no-ocr',partial=mode==='partial',doubleOcr=mode==='double-ocr';
 const calls:string[]=[],interpretations:string[]=[];
 let tailFail=partial,tailRuns=0,uninstallRecipe:()=>void=()=>{};
 let holdStage=false,stageEntered:()=>void=()=>{},releaseStage:()=>void=()=>{};
 t.after(()=>releaseStage());
 const provider=createServer(async(req,res)=>{
  for await(const _ of req){}
  const owner=req.headers.authorization==='Bearer GENERATED_CUSTOM_A'?'A':'B';calls.push(owner);
  res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,engine:'generated',segments:[{startMs:0,endMs:0,text:'GENERATED_'+owner+'_OCR'}]}));
 });
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
 t.after(()=>{provider.closeAllConnections();return new Promise<void>(r=>provider.close(()=>r()));});
 const address=provider.address();assert.ok(address&&typeof address!=='string');
 const f=await scopedFilesFixture(t,host=>{
  const registry=host.processing!.processors.imageRecipes;
  registry.registerStage({id:'generated.ui-interpretation',version:'1',kind:'derived',run:async input=>{
   const pixels=await input.readImage({view:'image'});assert.equal(pixels.imageView?.original.width,2);
   const text=withOcr?'INTERPRETATION_'+(input.dependencies.ocr as any).segments[0].text:'INTERPRETATION_'+input.record.windowTitle;
   interpretations.push(text);if(holdStage){stageEntered();await new Promise<void>(r=>releaseStage=r);}return {text,regions:[{x:0,y:0,width:1,height:1,description:''}]};
  }});
  registry.registerStage({id:'generated.ui-tail',version:'1',kind:'derived',run:async input=>{tailRuns++;const text=(input.dependencies.interpretation as any).text;if(tailFail&&text.includes('GENERATED_A_OCR'))throw Error('Generated tail failure');return {text:'TAIL_'+text,regions:[]};}});
  uninstallRecipe=registry.registerRecipe({id:'generated.ui-image',version:'1',steps:[...(withOcr?[{name:'ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]}]:[]),...(doubleOcr?[{name:'second-ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:['ocr']}]:[]),{name:'interpretation',stage:{id:'generated.ui-interpretation',version:'1'},dependsOn:withOcr?['ocr']:[]},...(partial?[{name:'tail',stage:{id:'generated.ui-tail',version:'1'},dependsOn:['interpretation']}]:[])]});
 });
 for(const [actor,label] of [[f.a,'A'],[f.b,'B']] as const){
  const page=await f.checked(actor.token,'/api/file-processing');
  await f.checked(actor.token,'/api/file-processing','PUT',{
   revision:page.revision,settings:{...page.settings,automatic:true,understandingEnabled:!withOcr,summarize:false},
   policy:{version:1,services:withOcr?[{id:'ocr',name:'Generated OCR',kind:'image',reference:{kind:'personal',id:'same-ocr'}}]:[],profiles:[
    {id:'image',name:'Generated custom recipe',processorId:'image.http',...(withOcr?{serviceId:'ocr'}:{}),parameters:{},summarize:false,imageRecipe:{id:'generated.ui-image',version:'1'}},
    {id:'archive',name:'Generated archive',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'image/*',profileId:'image'},{type:'*/*',profileId:'archive'}]},
   ...(withOcr?{models:{profiles:[{id:'same-ocr',name:'Generated OCR',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:'+address.port+'/ocr',apiKey:'GENERATED_CUSTOM_'+label,model:''}}],selections:{}}}:{})
  });
 }
 const png=await sharp({create:{width:2,height:2,channels:3,background:'#447733'}}).png().toBuffer();
 const a=await f.uploadBytes(f.a.token,'same-custom-ui',png,'image/png'),b=await f.uploadBytes(f.b.token,'same-custom-ui',png,'image/png');assert.equal(a.id,b.id);
 const details:any[]=[];
 for(const actor of [f.a,f.b])await waitForScopedState(async()=>{
  const detail=await f.checked(actor.token,'/api/files/'+a.id);
  if(detail.job?.state===(partial&&actor===f.a?'failed':'succeeded')){details.push(detail);return true;}return false;
 },()=> 'Actual custom recipe has not completed',20000);
 assert.equal(interpretations.length,2);assert.equal(calls.length,withOcr?2:0);
 if(!withOcr){assert.equal(details[0].processing.artifactId,undefined);assert.equal(details[0].processing.materialId,undefined);assert.equal(details[0].rawArtifactId,undefined);}
 const typedId=details[0].processing.derivations.find((item:any)=>item.kind.startsWith('image:')).artifactId;
 const artifact=await f.checked(f.a.token,'/api/processing/artifacts/'+typedId);
 assert.equal(artifact.payload.format,'mote-image-product-v1');assert.equal(artifact.payload.interpretation.regions[0].description,'');
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library?view=files',pretendToBeVisual:true});
 const saved=new Map<string,PropertyDescriptor|undefined>();let cookie='',current:Api|undefined,holdRead=false,readEntered:()=>void=()=>{},releaseRead:()=>void=()=>{};
 const writes:string[]=[];let actionAcks=0;t.after(()=>releaseRead());
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(path:string,init:RequestInit={})=>{
  const headers=new Headers(init.headers);headers.set('cookie',cookie);
  if(init.method==='POST'&&path.startsWith('/api/images/'))writes.push(String(init.body));
  const requestCookie=cookie;
  const response=await f.host.app.inject({url:path,method:init.method as any??'GET',headers:Object.fromEntries(headers),...(init.body?{payload:String(init.body)}:{})});
  if(init.method==='POST'&&path.startsWith('/api/images/'))actionAcks++;
  if(holdRead&&requestCookie===heldCookie&&path==='/api/images/'+a.id&&(!init.method||init.method==='GET')){readEntered();await new Promise<void>(r=>releaseRead=r);}
  return new Response(response.body,{status:response.statusCode,headers:response.headers as HeadersInit});
 }})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 let heldCookie='';
 const d=dom.window.document,root=createRoot(d.getElementById('root')!);
 t.after(async()=>{current?.close?.();await act(async()=>root.unmount());dom.window.close();for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const login=async(label:string)=>{
  const response=await f.request(undefined,'/api/auth/login','POST',{username:'generated-'+label,password:'Generated-joint-files-password',mode:'web'});assert.equal(response.statusCode,200,response.body);cookie=String(response.headers['set-cookie']).split(';')[0];
  const api=createApi({mode:'web',origin:'http://localhost',...response.json()},undefined,()=>current===api);current?.close?.();current=api;return api;
 };
 const api=await login('a');
 await act(async()=>{root.render(React.createElement(FileDetail,{api,id:a.id,onOpen:()=>{}}));await delay(30);});
 await waitForScopedState(async()=>{await act(async()=>delay(10));return !!d.querySelector('.image-progress');},()=>d.body.textContent??'',20000);
 const section=d.querySelector('.image-progress')!,state=(label:string)=>Array.from(section.querySelectorAll('dt')).find(node=>node.textContent===label)?.nextElementSibling?.textContent;
 assert.equal(state('文字识别'),withOcr?'已就绪':'未安排');
 assert.equal(state('内容理解'),partial?'处理失败':'已就绪','current named steps determine the aggregate, while accepted interpretations remain visible');
 assert.match(section.textContent!,new RegExp(artifact.payload.interpretation.text));
 assert.doesNotMatch(state('记忆（Memory）')??'',/已完成/);
 const progress=await f.checked(f.a.token,'/api/images/'+a.id);
 const product=progress.products.find((p:any)=>p.id===artifact.id);assert.ok(product,'explicit named derivation artifact is projected');
 assert.equal(product.kind,'image');assert.deepEqual(product.interpretation,artifact.payload);
 assert.equal(progress.products.filter((p:any)=>p.kind==='ocr').length,doubleOcr?2:withOcr?1:0);
 assert.equal(section.querySelectorAll('dt').length,5);assert.equal(state('原件'),'已就绪');assert.match(state('资料索引')??'',/已就绪/);
 const modelView=Array.from(section.querySelectorAll('details')).find(node=>node.querySelector('summary')?.textContent?.includes('查看图片理解'));assert.ok(modelView);assert.match(modelView.textContent!,/以下为模型解释/);
 if(!withOcr)assert.ok(!Array.from(d.querySelectorAll('button')).some(node=>node.textContent==='展开转写 / 原文片段'));
 if(doubleOcr){const ocrView=Array.from(section.querySelectorAll('details')).find(node=>node.querySelector('summary')?.textContent?.includes('文字识别'));assert.ok(ocrView,'the explicit named OCR derivation stays readable in the original UI');assert.match(ocrView.textContent!,/GENERATED_A_OCR/);assert.doesNotMatch(ocrView.textContent!,/INTERPRETATION_/);}

 const button=(label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('.image-progress button')).find(node=>node.textContent===label);
 const refresh=async()=>act(async()=>{resources(current!).get('/api/images/'+a.id).refresh();await delay(20);});
 const press=async(label:string)=>{const before=actionAcks;await act(async()=>{const node=button(label);assert.ok(node,label);assert.equal(node.disabled,false,label);node.click();await delay(30);});await waitForScopedState(async()=>{await act(async()=>delay(10));return actionAcks>before;},()=>label+' ACK not received',20000);};
 const settled=async()=>waitForScopedState(async()=>{
  const view=await f.checked(f.a.token,'/api/images/'+a.id);return !view.canCancel&&!view.wait;
 },()=> 'Image command did not settle',20000);
 tailFail=false;await press('补齐未完成步骤');await settled();await refresh();
 assert.equal(interpretations.length,2,'complete must preserve every successful custom interpretation');
 assert.equal(calls.length,withOcr?2:0,'complete does not rerun OCR');
 if(partial)assert.equal(tailRuns,3,'only the missing tail is completed');
 await press('重新计算已有结果');
 await waitForScopedState(async()=>interpretations.length===3,()=> 'Explicit recompute did not run custom step',20000);await settled();await refresh();
 assert.equal(calls.length,withOcr?3:0,'explicit recompute reruns actual OCR when the recipe has it');
 const beforeCancel=await f.checked(f.a.token,'/api/files/'+a.id),entered=new Promise<void>(r=>stageEntered=r);holdStage=true;
 await press('重新计算已有结果');await entered;await refresh();
 assert.equal(state('内容理解'),'处理中');
 await press('停止处理');releaseStage();holdStage=false;await settled();await refresh();
 assert.equal(state('内容理解'),'已取消');
 const afterCancel=await f.checked(f.a.token,'/api/files/'+a.id);
 assert.ok(afterCancel.processing.derivations.filter((item:any)=>item.kind.startsWith('image:')).every((item:any)=>beforeCancel.processing.derivations.some((previous:any)=>previous.artifactId===item.artifactId)),'late cancelled interpretation cannot publish a replacement; fresh OCR may already retire old derivatives');
 const retiredButton=button('补齐未完成步骤')!;heldCookie=cookie;holdRead=true;
 const enteredRead=new Promise<void>(r=>readEntered=r);await act(async()=>{resources(api).get('/api/images/'+a.id).refresh();await delay(20);});await enteredRead;
 const apiB=await login('b');await act(async()=>{root.render(React.createElement(FileDetail,{api:apiB,id:b.id,onOpen:()=>{}}));await delay(30);});
 const written=writes.length;await act(async()=>{retiredButton.click();await delay(10);releaseRead();await delay(20);});holdRead=false;
 assert.equal(writes.length,written,'retired A node cannot issue an action as B');
 if(withOcr){assert.match(d.querySelector('.image-progress')!.textContent!,/INTERPRETATION_GENERATED_B_OCR/);assert.doesNotMatch(d.querySelector('.image-progress')!.textContent!,/INTERPRETATION_GENERATED_A_OCR/);}
 assert.equal((await f.request(f.b.token,'/api/processing/artifacts/'+artifact.id)).statusCode,404);
 await f.restart();assert.ok((await f.checked(f.a.token,'/api/images/'+a.id)).jobs.some((job:any)=>job.state==='cancelled'));
 assert.equal((await f.checked(f.b.token,'/api/files/'+b.id)).processing.derivations[0].artifactId,details[1].processing.derivations[0].artifactId);
 uninstallRecipe();const unavailable=await f.checked(f.b.token,'/api/images/'+b.id);assert.equal(unavailable.original.state,'ready');assert.ok(unavailable.jobs.every((job:any)=>job.state==='blocked'&&job.error==='image_recipe_unavailable'));
 await refresh();assert.match(d.querySelector('.image-progress')!.textContent!,/需要处理/);assert.doesNotMatch(d.querySelector('.image-progress')!.textContent!,/scope_unavailable/);
});
