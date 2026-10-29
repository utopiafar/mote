import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {materialId} from '../../server/src/materials.js';
import sharp from 'sharp';
import {uploadNoteAttachment} from '../src/note-attachments.js';
import type {Api} from '../src/api.js';
const directory=process.argv[2];if(!directory)throw Error('Generated fixture directory required');
const token=randomBytes(32).toString('hex'),when='2026-10-29T01:00:00.000Z',noteId=randomUUID(),reportId=randomUUID();
const runtime=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
runtime.app.addHook('onRequest',async(req,reply)=>{
 if(req.url==='/api/devices/first-data'&&existsSync(join(directory,'first-data-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated receipt read unavailable'});
 if(req.url==='/api/notes'&&req.method==='POST'&&existsSync(join(directory,'deny-note')))return reply.code(403).send({error:'forbidden',message:'Generated note permission denied'});
});
const headers={authorization:'Bearer '+token};
const invitation=await runtime.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'本轮生成手机'}});
if(invitation.statusCode!==200)throw Error(invitation.body);
const redeemed=await runtime.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android'}});
if(redeemed.statusCode!==200)throw Error(redeemed.body);
const collector={authorization:'Bearer '+redeemed.json().token,'x-mote-ingress-version':'2'};
await runtime.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:collector,payload:{deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android',status:'paused',queueDepth:0}});
const created=await runtime.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:{id:noteId,deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android',capturedAt:when,text:'本轮生成的原始资料：先把资料阅读和提问之间的路径走通，再讨论其他页面。'}});
if(created.statusCode!==201)throw Error(created.body);
runtime.sources.register({id:'generated-home-source',name:'本轮生成资料',kind:'custom',deviceId:'generated-import',platform:'import'});
runtime.sources.reportStatus('generated-home-source',{state:'error',code:'source_adapter_unavailable'});
const imageBytes=await sharp({create:{width:48,height:60,channels:3,background:'#d9c6a2'}}).png().toBuffer();
const imageId=await uploadNoteAttachment({request:async(path:string,init:RequestInit)=>{
 const response=await runtime.app.inject({method:init.method as 'POST'|'PUT',url:path,headers:{...headers,...init.headers},payload:typeof init.body==='string'?JSON.parse(init.body):init.body?Buffer.from(init.body as ArrayBuffer):undefined});
 if(response.statusCode>=400)throw Error(response.body);return response.json();
}} as Api,new File([imageBytes],'本轮生成图片.png',{type:'image/png',lastModified:Date.parse(when)}),'generated-web');
const materialRefs=[];
for(const [index,title,text] of [[0,'评审准备记录','先把资料阅读和提问之间的路径走通，再讨论其他页面。'],[1,'评审议程.md','先检查用户能否找到内容，然后检查能否顺利继续下一步。'],[2,'本轮生成图片.png','这份图片由验收脚本创建，不包含个人资料。']] as const){
 const member=index===2?imageId:noteId;
 const material=runtime.materials.publish({id:materialId('generated-home-source',String(index)),kind:index===0?'mote.note':'mote.file',schemaVersion:1,title,origin:{sourceId:'generated-home-source',externalId:String(index),firstAt:when,lastAt:when,deviceId:'generated-phone'},members:[{id:member,kind:'capture',ref:'capture:'+member}],blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[member]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 materialRefs.push(material.ref);
}
const citations=[{id:noteId,appName:'本轮生成资料',capturedAt:when,excerpt:'先把资料阅读和提问之间的路径走通。'}];
runtime.store.saveInsight({runId:reportId,answer:'这次评审先看阅读与引用的完整路径。会前有两项准备，需要放在一起核对。',citations,trace:[],artifact:{id:randomUUID(),title:'周五评审前，有两项准备需要对齐',html:'<h1>本轮生成的资料回顾</h1><p>原始资料仍然可读。</p>',createdAt:when,skillId:'generated-fixture',skillVersion:'1'}},reportId);
const conversation=runtime.featureServices.conversations.append(undefined,{question:'周五评审需要准备什么？'},{runId:randomUUID(),answer:'先核对资料阅读与引用路径。',citations,trace:[]});
const provider={id:'fixture.home-question',version:'1',installationEpoch:'generated-installation',validate:()=>true,answer:()=>({kind:'closed' as const,outcome:'Generated answer acknowledged'})};
runtime.featureServices.ownerQuestions.register(provider);
runtime.featureServices.ownerQuestions.create(provider,{key:'generated-home',operationId:'generated:home',workId:'generated-home',title:'请补充这份资料的背景',prompt:'这份记录来自哪个项目？',evidence:[{id:noteId,quote:'本轮生成的原始资料',offset:0}],choices:[],dependencyIds:[noteId],context:{generated:true}});
for(const title of ['检查资料阅读路径','核对引用返回路径']){const r=await runtime.app.inject({method:'POST',url:'/api/todos',headers,payload:{id:randomUUID(),title,dueAt:null}});if(r.statusCode!==201)throw Error(r.body);}
await runtime.connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated read-only agent',access:'read'},{directory:join(directory,'connectors'),mcpEnabled:true});
await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,noteId,reportId,conversationId:conversation.id,materialRefs,directory,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
