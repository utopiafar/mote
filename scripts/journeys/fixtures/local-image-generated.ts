/** Explicit IMG-08 generated stage only; this filename is outside ordinary test
 * globs. No real model, package installation, personal input or external peer. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {generatedLocalImageSetup} from '../../../apps/server/test/fixtures/media-setup.js';
import {generatedLocalImages,type LocalImageFixture} from '../../../apps/server/test/fixtures/local-image.js';
import {sha256} from '../../../apps/server/src/evidence-store.js';
import {localImageProcessingSelection} from '../../../apps/server/src/plugins/local-image-processing.js';
import {createModelAgent,type ModelAgentFactory} from '../../../apps/server/src/model-agent.js';

type Image=Omit<LocalImageFixture,'id'>&{id:string};
type ModelRequest={model:string;messages:any[];tools?:{function:{name:string}}[]};
type Reply={tool:string;args:unknown}|{answer:string;citationIds:string[]};
const text=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';
const result=(body:ModelRequest)=>JSON.parse(text(body.messages.filter(message=>message.role==='tool').at(-1)?.content).split('\n')[0]);
function pixels(body:ModelRequest){
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

async function fixture(t:TestContext){
 const runs:{model:string;phase:string;runId?:string;images:unknown[];answer:string}[]=[];
 const observe:ModelAgentFactory=async(settings,reader,hooks)=>{
  const actual=await createModelAgent(settings,reader,undefined,hooks?.runModel,hooks?.authorizeModelRequest);
  return {configured:actual.configured,close:()=>actual.close(),async query(input,lease){
   const result=await actual.query(input,lease);
   runs.push({model:settings.model,phase:input.traceContext?.phase??'ask',runId:result.runId,images:result.imageReadReceipts??[],answer:result.answer});
   return result;
  }};
 };
 const f=await generatedLocalImageSetup(t,'native',{script:fileURLToPath(new URL('./local_image_engine.py',import.meta.url)),token:'generated-img08-worker-token-64-characters-for-local-only-fixtures'},observe);
 assert.equal(f.supported,true,'this generated native worker stage needs the existing supported host; it does not establish other platforms');
 const images=await generatedImages(),expectations:Record<string,unknown>={};
 for(const image of images)expectations[sha256(image.bytes)]={pixelsSha256:sha256(await sharp(image.bytes).removeAlpha().toColourspace('srgb').raw().toBuffer()),interpretation:image.interpretation};
 await writeFile(join(f.directory,'expected-images.json'),JSON.stringify(expectations));
 const errors:unknown[]=[],requests:ModelRequest[]=[];let plan:((body:ModelRequest,step:number)=>Reply)|undefined;
 const provider=createServer((request,response)=>{void(async()=>{
  assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer generated-img08-selected-model');
  const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;assert.ok(size<24*1024*1024);chunks.push(Buffer.from(chunk));}
  const body=JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest,step=requests.push(body)-1;
  await appendFile(join(f.directory,'model-requests.ndjson'),JSON.stringify({step,model:body.model,structure:structure(body),pixels:pixels(body).map(bytes=>({bytes:bytes.length,sha256:sha256(bytes)})),lastTool:body.messages.filter(message=>message.role==='tool').at(-1)?.name})+'\n');
  assert.ok(plan,'every generated model operation has an explicit response plan');const reply=plan(body,step),tool='tool' in reply;
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.write('data: '+JSON.stringify({id:'generated-img08-'+step,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,id:'generated-img08-call-'+step,type:'function',function:{name:reply.tool,arguments:JSON.stringify(reply.args)}}]}:{role:'assistant',content:JSON.stringify(reply)},finish_reason:null}]})+'\n\n');
  response.write('data: '+JSON.stringify({id:'generated-img08-'+step,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100}})+'\n\n');response.end('data: [DONE]\n\n');
 })().catch(error=>{errors.push(error);if(!response.headersSent)response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Generated IMG-08 provider assertion failed'}}));});});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const ocr=createServer((request,response)=>{void(async()=>{
  assert.equal(request.url,'/ocr');const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  const bytes=Buffer.concat(chunks),image=images.find(image=>sha256(image.bytes)===sha256(bytes));assert.ok(image,'OCR receives only a generated original');
  response.writeHead(200,{'content-type':'application/json','X-Mote-Execution':'local'});response.end(JSON.stringify(image.ocr));
 })().catch(error=>{errors.push(error);response.writeHead(500).end();});});
 await new Promise<void>(resolve=>ocr.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const server of [provider,ocr]){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}assert.deepEqual(errors,[],'transport assertion failures remain visible');});
 await f.node.app.listen({host:'127.0.0.1',port:0});
 const central=()=>`http://127.0.0.1:${(f.node.app.server.address() as {port:number}).port}`;
 const api=async(method:string,path:string,body?:unknown)=>{
  const response=await fetch(central()+path,{method,headers:{authorization:'Bearer '+f.token,...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const value=await response.text();
  if(!response.ok)t.diagnostic(JSON.stringify({providerErrors:errors.map(error=>error instanceof Error?error.stack:String(error)),modelRequests:requests.map(body=>({model:body.model,structure:structure(body),pixels:pixels(body).map(bytes=>({size:bytes.length,sha256:sha256(bytes)})),tool:text(body.messages.filter(message=>message.role==='tool').at(-1)?.content).slice(0,500)}))}));
  assert.ok(response.ok,method+' '+path+': '+response.status+' '+value);return JSON.parse(value);
 };
 let models=await api('GET','/api/model-settings');
 models=await api('PUT','/api/model-settings',{revision:models.revision,settings:{provider:'custom',protocol:'openai-completions',model:'generated-img08-ask',baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,apiKey:'generated-img08-selected-model',headers:{},extraBody:{},reasoningEffort:'auto',maxTokens:8192,modelRequestTimeoutMs:30000,agentTimeoutMs:30000,allowUnauthenticatedLocal:true}});
 await api('PUT','/api/model-settings/defaults',{revision:models.revision,defaults:models.defaults,defaultModels:{chat:'generated-img08-ask',memory:'generated-img08-memory',file:'generated-img08-file'}});
 const processing=f.node.processing.imageDefaultDraft({endpoint:`http://127.0.0.1:${(ocr.address() as {port:number}).port}/ocr`});
 await api('PUT','/api/file-processing',{...processing,revision:f.node.processing.view().revision});
 await api('PUT','/api/perception',{revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:true}});
 const authorization=await api('GET','/api/model-authorization');
 await api('POST','/api/model-authorization/commands',{revision:authorization.authorization.revision,operationId:randomUUID(),action:'on'});
 f.node.sources.register({id:'generated-img08',name:'Generated IMG-08 originals',kind:'upload',deviceId:'generated-img08-device',platform:'import',retention:'archive'});
 let serial=0;
 const settle=async()=>{await f.node.processing.tick();await f.node.perception.tick();for(let i=0;i<30;i++)if(await f.node.materialOrganizer.tick(100)===0)return;assert.fail('Generated IMG-08 Material publication did not settle');};
 return {...f,get node(){return f.node;},images,api,requests,errors,runs,
  select(value:(body:ModelRequest,step:number)=>Reply){plan=value;requests.length=0;},
  async enable(value:boolean){const build=await api('GET','/api/plugin-builds/local-image');await api('PATCH','/api/plugin-builds/local-image',{expectedRevision:build.revision,operationId:randomUUID(),selection:value?localImageProcessingSelection:null});},
  async prepare(){await api('POST','/api/media-preparation/local-image',{});await f.until(async()=>{const status=await api('GET','/api/media-preparation');return status['local-image'].state==='prepared';},'generated environment and catalog prepare');},
  async upload(image:Image){
   const begin=await api('POST','/api/file-sync/v1/uploads',{sourceId:'generated-img08',item:{externalId:`${++serial}-${image.id}.png`,revision:'1',observedAt:'2026-11-17T00:00:00Z',kind:'file',layer:'original',mimeType:image.mimeType,title:'Generated IMG-08 reference',text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(image.bytes),sizeBytes:image.bytes.length});
   let ack=begin.ack;
   if(!ack){for(let offset=0,part=0;offset<image.bytes.length;offset+=begin.partBytes,part++)await api('PUT',`/api/file-sync/v1/uploads/${begin.uploadId}/parts/${part}`,image.bytes.subarray(offset,offset+begin.partBytes));ack=await api('POST',`/api/file-sync/v1/uploads/${begin.uploadId}/commit`,{});}
   await settle();return String(ack.id);
  },settle,
  async workerRequests(){return (await readFile(join(f.directory,'worker-requests.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));},
 };
}

test('generated IMG-08 A uses the default owner-selected Python worker and the real Ask pixel transport',{timeout:120000},async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='large')!;
 await f.prepare();await f.enable(true);assert.equal((await f.api('GET','/api/local-image-processing')).state,'ready');
 const captureId=await f.upload(image),detail=await f.api('GET','/api/images/'+captureId);
 assert.equal(detail.products.find((product:any)=>product.kind==='understanding')?.text,image.interpretation.text,JSON.stringify(detail));
 const worker=await f.workerRequests();assert.equal(worker.length,1);assert.equal(worker[0].originalSha256,sha256(image.bytes));assert.equal(worker[0].pixelBytes,1024*1024*3);
 assert.notEqual(worker[0].pid,await f.pid(),'real worker owns a separate model child');
 t.diagnostic(JSON.stringify({nodePid:process.pid,nodeParentPid:process.ppid,workerPid:await f.pid(),modelChildPid:worker[0].pid,originalBytes:image.bytes.length,pixelBytes:worker[0].pixelBytes}));
 let id='';const region={x:64,y:80,width:32,height:24};
 f.select((body,step)=>{
  assert.equal(body.model,'generated-img08-ask','intake cannot replace the selected Ask model');
  if(step===0)return {tool:'search_context',args:{query:'Generated large raster visual reference'}};
  if(step===1){const found=result(body).data;assert.equal(found.length,1);id=found[0].id;return {tool:'evidence',args:{ids:[id]}};}
  if(step===2)return {tool:'read_image',args:{id,view:'metadata'}};
  if(step===3){assert.equal(pixels(body).length,0,'metadata must not deliver image bytes');assert.equal(result(body).imageView.original.sha256,sha256(image.bytes));return {tool:'read_image',args:{id,expectedImageSha256:sha256(image.bytes)}};}
  if(step===4){const delivered=pixels(body);assert.equal(delivered.length,1);assert.equal(sha256(delivered[0]),sha256(image.bytes));return {tool:'read_image',args:{id,expectedImageSha256:sha256(image.bytes),region}};}
  assert.equal(step,5);return {answer:`The generated raster reference is available. [${id}]`,citationIds:[id]};
 });
 const answer=await f.api('POST','/api/query',{question:'Inspect the generated raster reference and its selected region.'});
 assert.deepEqual(f.errors,[]);assert.equal(f.requests.length,6);
 const deliveredOriginal=pixels(f.requests[4])[0],deliveredRgb=await sharp(deliveredOriginal).removeAlpha().toColourspace('srgb').raw().toBuffer();
 assert.equal(deliveredOriginal.length,image.bytes.length);assert.equal(deliveredRgb.length,3145728);
 assert.equal(sha256(deliveredRgb),sha256(await sharp(image.bytes).removeAlpha().toColourspace('srgb').raw().toBuffer()));
 assert.deepEqual(await sharp(pixels(f.requests[5]).at(-1)!).removeAlpha().raw().toBuffer(),await sharp(image.bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).removeAlpha().raw().toBuffer());
 assert.equal(answer.citations[0].id,id);assert.equal(answer.imageReadReceipts.length,2);
 assert.equal((await f.api('GET','/api/captures/'+id)).id,id,'the actual citation remains owner-readable');
 assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-img08-memory');
 assert.equal(f.node.modelSettings.select('file').settings.model,'generated-img08-file');
 t.diagnostic(JSON.stringify({stage:'generated-img08-A',modelRequests:f.requests.map((body,step)=>({step,model:body.model,pixels:pixels(body).map(bytes=>({bytes:bytes.length,sha256:sha256(bytes)}))})),deliveredOriginalRgb:{bytes:deliveredRgb.length,sha256:sha256(deliveredRgb)},imageReadReceipts:answer.imageReadReceipts,citationIds:answer.citations.map((citation:any)=>citation.id)}));
});
