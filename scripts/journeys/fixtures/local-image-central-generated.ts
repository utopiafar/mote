/** Explicit IMG-08 generated stage only; this filename is outside ordinary test
 * globs. No real model, package installation, personal input or external peer. */
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {generatedLocalImageSetup} from '../../../apps/server/test/fixtures/media-setup.js';
import {generatedLocalImages,type LocalImageFixture} from '../../../apps/server/test/fixtures/local-image.js';
import {sha256} from '../../../apps/server/src/store.js';
import {localImageProcessingSelection} from '../../../apps/server/src/plugins/local-image-processing.js';
import {createModelAgent,type ModelAgentFactory} from '../../../apps/server/src/model-agent.js';

export type Image=Omit<LocalImageFixture,'id'>&{id:string};
export type ModelRequest={model:string;messages:any[];tools?:{function:{name:string}}[]};
export type Reply={tool:string;args:unknown}|{json:unknown};
export const modelText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';
export const toolResult=(body:ModelRequest)=>JSON.parse(modelText(body.messages.filter(message=>message.role==='tool').at(-1)?.content).split('\n')[0]);
export function pixels(body:ModelRequest){
 const values:Buffer[]=[];
 for(const message of body.messages)if(message.role==='user'&&Array.isArray(message.content))for(const part of message.content){
  const url=part.type==='image_url'?part.image_url?.url:undefined;
  if(typeof url==='string'&&/^data:image\/(png|jpeg|webp);base64,/.test(url))values.push(Buffer.from(url.slice(url.indexOf(',')+1),'base64'));
 }
 return values;
}
const structure=(body:ModelRequest)=>body.messages.map(message=>({role:message.role,content:typeof message.content==='string'?'text':Array.isArray(message.content)?message.content.map((part:any)=>({type:part.type,keys:Object.keys(part)})):null,toolCalls:message.tool_calls?.map((call:any)=>call.function?.name)}));
async function generatedImages():Promise<Image[]>{
 const images:Image[]=await generatedLocalImages(),raw=Buffer.alloc(1024*1024*3);let seed=57;
 for(let index=0;index<raw.length;index++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[index]=seed>>>24;}
 const bytes=await sharp(raw,{raw:{width:1024,height:1024,channels:3}}).png({compressionLevel:0}).toBuffer();
 assert.ok(bytes.length>=3*1024*1024,'retain the complete media journey original-image regression scale');
 images.push({id:'large',bytes,width:1024,height:1024,mimeType:'image/png',ocr:{durationMs:0,segments:[]},interpretation:{text:'Generated large raster visual reference. It contains synthetic coloured pixels; authorship and real-world significance are unknown.',regions:[]}});
 return images;
}

export async function generatedImageCentral(t:TestContext){
 const runs:{model:string;phase:string;runId?:string;images:any[];answer:string;input:any;settled:boolean}[]=[];
 const observe:ModelAgentFactory=async(settings,reader,hooks)=>{
  const actual=await createModelAgent(settings,reader,undefined,hooks?.runModel,hooks?.authorizeModelRequest);
  return {configured:actual.configured,close:()=>actual.close(),async query(input,lease){
   const work=input.taskContext?.memoryWork as {catalog?:unknown;members?:unknown}|undefined;
   const run={model:settings.model,phase:work?.catalog?'plan':input.taskContext?.untrustedMemoryDraft?'review':work?.members?'extract':input.traceContext?.phase??'ask',images:[] as any[],answer:'',input,settled:false};
   runs.push(run);
   try{const result=await actual.query(input,lease);Object.assign(run,{runId:result.runId,images:result.imageReadReceipts??[],answer:result.answer});return result;}
   finally{run.settled=true;}
  }};
 };
 const f=await generatedLocalImageSetup(t,'native',{script:fileURLToPath(new URL('./local_image_engine.py',import.meta.url)),token:'generated-img08-worker-token-64-characters-for-local-only-fixtures'},observe);
 assert.equal(f.supported,true,'this generated native worker stage needs the existing supported host; it does not establish other platforms');
 const images=await generatedImages(),expectations:Record<string,unknown>={};
 for(const image of images)expectations[sha256(image.bytes)]={pixelsSha256:sha256(await sharp(image.bytes).removeAlpha().toColourspace('srgb').raw().toBuffer()),interpretation:image.interpretation};
 await writeFile(join(f.directory,'expected-images.json'),JSON.stringify(expectations));
 const errors:unknown[]=[],requests:ModelRequest[]=[];let plan:((body:ModelRequest,step:number)=>Reply|Promise<Reply>)|undefined,ocrFailure:false|503|422=false;
 const provider=createServer((request,response)=>{void(async()=>{
  assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer generated-img08-selected-model');
  const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;assert.ok(size<24*1024*1024);chunks.push(Buffer.from(chunk));}
  const body=JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest,step=requests.push(body)-1;
  await appendFile(join(f.directory,'model-requests.ndjson'),JSON.stringify({step,model:body.model,structure:structure(body),pixels:pixels(body).map(bytes=>({bytes:bytes.length,sha256:sha256(bytes)})),lastTool:body.messages.filter(message=>message.role==='tool').at(-1)?.name})+'\n');
  assert.ok(plan,'every generated model operation has an explicit response plan');const reply=await plan(body,step),tool='tool' in reply;
  if(response.destroyed)return;
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.write('data: '+JSON.stringify({id:'generated-img08-'+step,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,id:'generated-img08-call-'+step,type:'function',function:{name:reply.tool,arguments:JSON.stringify(reply.args)}}]}:{role:'assistant',content:JSON.stringify('json' in reply?reply.json:reply)},finish_reason:null}]})+'\n\n');
  response.write('data: '+JSON.stringify({id:'generated-img08-'+step,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100}})+'\n\n');response.end('data: [DONE]\n\n');
 })().catch(error=>{errors.push(error);if(!response.headersSent)response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Generated IMG-08 provider assertion failed'}}));});});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const ocr=createServer((request,response)=>{void(async()=>{
  assert.equal(request.url,'/ocr');const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  const bytes=Buffer.concat(chunks),image=images.find(image=>sha256(image.bytes)===sha256(bytes));assert.ok(image,'OCR receives only a generated original');
  if(ocrFailure){response.writeHead(ocrFailure,{'content-type':'application/json','X-Mote-Execution':'local'});response.end(JSON.stringify({error:ocrFailure===503?'generated OCR boundary unavailable':'generated OCR boundary rejected this original'}));return;}
  response.writeHead(200,{'content-type':'application/json','X-Mote-Execution':'local'});response.end(JSON.stringify(image.ocr));
 })().catch(error=>{errors.push(error);response.writeHead(500).end();});});
 await new Promise<void>(resolve=>ocr.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const server of [provider,ocr]){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}assert.deepEqual(errors,[],'transport assertion failures remain visible');});
 await f.node.app.listen({host:'127.0.0.1',port:0});
 const central=()=>`http://127.0.0.1:${(f.node.app.server.address() as {port:number}).port}`;
 const raw=async(method:string,path:string,body?:unknown)=>{
  const response=await fetch(central()+path,{method,headers:{authorization:'Bearer '+f.token,...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const value=Buffer.from(await response.arrayBuffer());
  return {status:response.status,body:!value.length?null:response.headers.get('content-type')?.includes('json')?JSON.parse(value.toString()):{bytes:value.length,sha256:sha256(value)}};
 };
 const api=async(method:string,path:string,body?:unknown)=>{
  const response=await raw(method,path,body);
  if(response.status>=400)t.diagnostic(JSON.stringify({providerErrors:errors.map(error=>error instanceof Error?error.stack:String(error)),modelRequests:requests.map(body=>({model:body.model,structure:structure(body),pixels:pixels(body).map(bytes=>({size:bytes.length,sha256:sha256(bytes)})),tool:modelText(body.messages.filter(message=>message.role==='tool').at(-1)?.content).slice(0,500)}))}));
  assert.ok(response.status<400,method+' '+path+': '+response.status+' '+JSON.stringify(response.body));return response.body;
 };
 let models=await api('GET','/api/model-settings');
 models=await api('PUT','/api/model-settings',{revision:models.revision,settings:{provider:'custom',protocol:'openai-completions',model:'generated-img08-ask',baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,apiKey:'generated-img08-selected-model',headers:{},extraBody:{},reasoningEffort:'auto',maxTokens:8192,modelRequestTimeoutMs:30000,agentTimeoutMs:30000,allowUnauthenticatedLocal:true}});
 await api('PUT','/api/model-settings/defaults',{revision:models.revision,defaults:models.defaults,defaultModels:{chat:'generated-img08-ask',memory:'generated-img08-memory',file:'generated-img08-file'}});
 const processing=f.node.processing.imageDefaultDraft({endpoint:`http://127.0.0.1:${(ocr.address() as {port:number}).port}/ocr`});
 await api('PUT','/api/file-processing',{...processing,revision:f.node.processing.view().revision});
 await api('PUT','/api/perception',{revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:true}});
 const authorization=await api('GET','/api/model-authorization');
 await api('POST','/api/model-authorization/commands',{revision:authorization.authorization.revision,operationId:randomUUID(),action:'on'});
 await api('POST','/api/sources',{id:'generated-img08',name:'Generated IMG-08 originals',kind:'upload',deviceId:'generated-img08-device',platform:'import',retention:'archive'});
 let serial=0;
 const settle=async()=>{await f.node.processing.tick();await f.node.perception.tick();for(let i=0;i<30;i++)if(await f.node.materialOrganizer.tick(100)===0)return;assert.fail('Generated IMG-08 Material publication did not settle');};
 return {...f,get node(){return f.node;},images,api,raw,requests,errors,runs,
  failOcr(value:boolean|422=true){ocrFailure=value===true?503:value===false?false:value;},
  async restart(){await f.restart();await f.node.app.listen({host:'127.0.0.1',port:0});},
  select(value:(body:ModelRequest,step:number)=>Reply|Promise<Reply>){plan=value;requests.length=0;},
  async enable(value:boolean){const build=await api('GET','/api/plugin-builds/local-image');await api('PATCH','/api/plugin-builds/local-image',{expectedRevision:build.revision,operationId:randomUUID(),selection:value?localImageProcessingSelection:null});},
  async prepare(){await api('POST','/api/media-preparation/local-image',{});await f.until(async()=>{const status=await api('GET','/api/media-preparation');return status['local-image'].state==='prepared';},'generated environment and catalog prepare');},
  async upload(image:Image,options:{sourceId?:string;externalId?:string;revision?:string;previousRevision?:string;processingProfileId?:string;settle?:boolean}={}){
   const begin=await api('POST','/api/file-sync/v1/uploads',{sourceId:options.sourceId??'generated-img08',...(options.previousRevision?{previousRevision:options.previousRevision}:{}),...(options.processingProfileId?{processingProfileId:options.processingProfileId}:{}),item:{externalId:options.externalId??`${++serial}-${image.id}.png`,revision:options.revision??'1',observedAt:'2026-11-17T00:00:00Z',kind:'file',layer:'original',mimeType:image.mimeType,title:'Generated IMG-08 reference',text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(image.bytes),sizeBytes:image.bytes.length});
   let ack=begin.ack;
   if(!ack){for(let offset=0,part=0;offset<image.bytes.length;offset+=begin.partBytes,part++)await api('PUT',`/api/file-sync/v1/uploads/${begin.uploadId}/parts/${part}`,image.bytes.subarray(offset,offset+begin.partBytes));ack=await api('POST',`/api/file-sync/v1/uploads/${begin.uploadId}/commit`,{});}
   if(options.settle!==false)await settle();return String(ack.id);
  },settle,
  async screen(image:Image){const id=randomUUID();await api('POST','/api/captures',{id,deviceId:'generated-img08-screen',deviceName:'Generated screen',platform:'android',source:'screen',capturedAt:'2026-11-17T00:00:00Z',durationMs:0,ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:image.mimeType,imageBase64:image.bytes.toString('base64')});await settle();return id;},
  async workerRequests(){let value='';try{value=await readFile(join(f.directory,'worker-requests.ndjson'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));},
 };
}
