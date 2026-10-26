import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../apps/server/src/app.js';
import {fixtureMemoryResult} from '../../apps/server/test/fixtures/memory-result.js';
const dataDir=mkdtempSync(join(tmpdir(),'mote-native-topics-'));
const token='generated-native-topics-owner-token';
const port=Number(process.env.MOTE_TOPICS_PORT??47894);
const node=await buildApp({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No live model');},close:async()=>{}}});
let mode='online';let state:any={};let ids:string[]=[];
node.app.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/api/context-trees')&&mode!=='online')return reply.code(mode==='denied'?403:503).send({error:mode==='denied'?'connection_scope_denied':'fixture_offline'});});
node.app.post('/api/__fixture/mode',async req=>{mode=String((req.body as any).mode);return {mode};});
node.app.get('/api/__fixture/state',async()=>state);
node.app.post('/api/__fixture/empty',async()=>{for(const id of ids)node.memories.delete(id);return {ok:true};});
node.app.post('/api/__fixture/invalidate',async()=>{node.memories.delete(ids[0]);return {ok:true};});
node.app.post('/api/__fixture/reset',async()=>{
 mode='online';for(const id of ids)try{node.memories.delete(id);}catch{}ids=[];
 const notes:string[]=[];const at=new Date().toISOString();
 for(let i=0;i<32;i++){
  const id=randomUUID(),text='Synthetic native topic original '+i;notes.push(id);
  await node.store.ingest({id,deviceId:'generated-topics-device',deviceName:'Synthetic native fixture',platform:'import',capturedAt:at,durationMs:0,source:'note',appId:'mote.note',appName:'Synthetic topic note',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});
  const result=fixtureMemoryResult(node.memories,{answer:JSON.stringify({memories:[{title:'Synthetic topic memory '+i,statement:text+' ['+id+']',uncertainty:'Synthetic fixture only',evidenceIds:[id]}]}),citations:[{id,capturedAt:at,appName:'Synthetic topic note',excerpt:text}],trace:[],runId:randomUUID()});
  const saved=node.memories.extract(result,'fixture',{reviewReceipt:{policy:'bounded-exact-review@1',decision:'independent',draftRunId:result.runId!,reviewRunId:randomUUID(),checkedAt:at,deletionSnapshot:node.memories.deletions.snapshot()}}).items[0];node.memories.publish(saved.id);ids.push(saved.id);
 }
 await node.featureServices.contextTrees.automatic!.classify({operationId:randomUUID(),classifierId:'fixture',memoryIds:ids},{admissionId:'generated-only-admission',signal:new AbortController().signal,assertCurrent:()=>{}});
 const trees=await node.featureServices.contextTrees.automatic!.trees();
 state={firstMemory:ids[0],firstNote:notes[0],treeOne:trees.find(t=>t.label==='合成项目')!.id,treeTwo:trees.find(t=>t.label==='合成实践')!.id};return state;
});
await node.app.ready();
node.featureServices.contextTrees.automatic!.register({id:'fixture',version:'1',classify:async()=>({trees:[{id:'project',label:'合成项目',nodes:[{id:'planning',label:'合成计划',memoryIds:ids},{id:'review',label:'合成复核',memoryIds:[ids[0]]}]},{id:'practice',label:'合成实践',nodes:[{id:'reuse',label:'合成复用',memoryIds:[ids[0]]}]}]})});
await node.app.listen({host:'127.0.0.1',port});console.log('Synthetic native topics fixture listening on '+port);
process.once('SIGTERM',async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});process.exit(0);});
