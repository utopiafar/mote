import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../../server/src/app.js';
import {materialId} from '../../server/src/materials.js';

// Generated data and a generated provider transport in one private test profile.
const directory=process.argv[2];if(!directory)throw Error('Private fixture directory required');
const token=randomBytes(32).toString('hex'),headers={authorization:'Bearer '+token},at='2026-11-01T08:00:00.000Z';
const ids:string[]=[];let outside='',providerCalls=0,originalsRead=false,leaked=false;
const provider=createServer(async(request,response)=>{
 let body='';for await(const part of request)body+=part;
 providerCalls++;
 const messages=JSON.parse(body).messages as {role:string}[],read=messages.some(item=>item.role==='tool');
 if(read){originalsRead=ids.every((_,index)=>body.includes('GENERATED_UI_ALLOWED_'+index));leaked=body.includes('GENERATED_UI_OUTSIDE_BODY')||body.includes('Generated unselected block');}
 if(response.destroyed)return;response.writeHead(200,{'Content-Type':'text/event-stream'});
 const delta=read?{role:'assistant',content:JSON.stringify({answer:JSON.stringify({answer:'Generated bounded task result. Identity and completion remain unknown.',actions:[]}),citationIds:ids})}
  :{role:'assistant',tool_calls:[{index:0,id:'generated-scope-read',type:'function',function:{name:'evidence',arguments:JSON.stringify({ids:[...ids,outside]})}}]};
 for(const value of [{id:'generated-scope-provider',choices:[{index:0,delta,finish_reason:null}]},{id:'generated-scope-provider',choices:[{index:0,delta:{},finish_reason:read?'stop':'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}])response.write('data: '+JSON.stringify(value)+'\n\n');
 response.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
const runtime=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512,apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'},{backgroundWorker:false});
for(let index=0;index<1003;index++)await runtime.store.ingest({id:randomUUID(),deviceId:'generated-ui-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:'Generated unrelated library record '+index});
for(let index=0;index<2;index++){
 const sourceId='generated-ui-source-'+index;
 runtime.sources.register({id:sourceId,name:'Generated selected source '+index,kind:'custom',deviceId:'generated-ui-device',platform:'import'});
 ids.push((await runtime.sources.upsert(sourceId,{externalId:'selected',revision:'1',observedAt:at,title:'Generated selected document '+index,kind:'message',layer:'original',text:'GENERATED_UI_ALLOWED_'+index})).id);
}
runtime.sources.register({id:'generated-ui-outside',name:'Generated unrelated source',kind:'custom',deviceId:'generated-ui-device',platform:'import'});
outside=(await runtime.sources.upsert('generated-ui-outside',{externalId:'wide',revision:'1',observedAt:at,title:'Generated unrelated document',kind:'message',layer:'original',text:'Generated unselected source. '.repeat(10)+'GENERATED_UI_OUTSIDE_BODY'})).id;
runtime.materials.publish({id:materialId('generated-ui-outside','wide'),kind:'mote.file',schemaVersion:1,title:'Generated oversized unrelated Material',origin:{sourceId:'generated-ui-outside',externalId:'wide',deviceId:'generated-ui-device',firstAt:at,lastAt:at},members:[{id:'original',kind:'capture',ref:'capture:'+outside}],blocks:Array.from({length:1002},(_,index)=>({id:'body-'+index,kind:'text' as const,format:'plain' as const,text:'Generated unselected block '+index,memberIds:['original']})),artifacts:[{key:'source-body',state:'ready',blockIds:Array.from({length:1002},(_,index)=>'body-'+index)}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},{expectedRevision:null});
const all={kind:'all' as const},matter=runtime.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated UI matter',scope:all},{currentEvidence:()=>[],currentTask:()=>undefined});
const card=runtime.featureServices.assistantCards.publish({id:randomUUID(),kind:'suggestion',matterId:matter.id,version:'generated-v1',state:'open',title:'Generated UI bounded suggestion',body:'Use the two selected documents. Identity and completion are unknown.',evidence:ids.map((id,index)=>({id,quote:'GENERATED_UI_ALLOWED_'+index})),evidenceDependencies:{version:1,complete:true,ids}},undefined,all,()=>{});
runtime.app.get('/__fixture/status',async(request,reply)=>{
 if(request.headers.authorization!==headers.authorization)return reply.code(403).send({error:'forbidden'});
 return {providerCalls,originalsRead,leaked,tasks:runtime.store.db.prepare("SELECT id,state FROM task_records WHERE kind='assistant.task'").all()};
});
await runtime.app.listen({host:'127.0.0.1',port:0});
// Only the hidden runner consumes this pipe; credentials are never in evidence.
console.log(JSON.stringify({server:runtime.app.server.address(),token,cardId:card.id,ids:ids.sort(),generatedOnly:true}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>{provider.closeAllConnections();provider.close(()=>process.exit(0));});});
