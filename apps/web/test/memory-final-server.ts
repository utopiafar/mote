// Generated UI fixture; real Central reads/cancellation, no provider calls.
import {join} from 'node:path';
import {existsSync,rmSync,writeFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {memoryEvidenceFingerprint} from '../../server/src/memory.js';
const directory=process.argv[2],webRoot=process.argv[3];if(!directory||!webRoot)throw Error('Private fixture directory and built web root required');
const token=randomBytes(32).toString('hex'),when=new Date().toISOString();let modelCalls=0;
const runtime=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-unavailable-model',modelBaseUrl:'http://127.0.0.1:9/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{webRoot,backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No model calls allowed');},close:async()=>{}}});
const memoryIds:string[]=[];
runtime.app.addHook('onRequest',async(req,reply)=>{
 if(req.url==='/api/memory-settings'&&existsSync(join(directory,'queue-generated-window'))){runtime.lifecycle.request('consolidation',[memoryIds[0]],'');rmSync(join(directory,'queue-generated-window'));}
 if(req.url==='/api/memory-jobs'&&req.method==='POST'&&existsSync(join(directory,'extraction-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated extraction submission unavailable'});
 if(req.url==='/api/memory-integrations'&&req.method==='POST'&&existsSync(join(directory,'integration-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated integration submission unavailable'});
});
const headers={authorization:'Bearer '+token},noteId=randomUUID();
const note=await runtime.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:noteId,deviceId:'generated-memory-ui',deviceName:'Generated UI fixture',platform:'import',capturedAt:when,text:'本轮生成资料：记录实际阅读路径与返回位置。'}});if(note.statusCode!==201)throw Error(note.body);
const record=runtime.memories.readEvidence([noteId])[0],quote='记录实际阅读路径与返回位置',offset=record.ocrText.indexOf(quote);if(offset<0)throw Error('Generated evidence quote missing');
for(const [index,status]of ['published','stale','proposed'].entries()){
 const id=randomUUID(),memory={id,version:1,domain:'personal',tier:'episode',kind:'episodic',title:['保留阅读与返回的位置','需要重验的阅读经验','等待重新处理的阅读经验'][index],statement:'从资料发起提问时，应保留原文入口与原来的阅读位置。',uncertainty:'仅来自本轮生成的验收资料。',status,createdAt:when,model:'generated-controlled-fixture',runId:'generated-controlled-fixture',fingerprint:String(index+1).repeat(64),evidenceIds:[noteId],evidence:[{id:noteId,deviceId:record.deviceId,capturedAt:record.capturedAt,receivedAt:record.receivedAt,offset,length:quote.length,quote,contentHash:memoryEvidenceFingerprint(record)}],admission:{layer:'memory',reason:'Generated UI fixture',scope:'Generated validation only',attribution:'user'}};
 runtime.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id,when,JSON.stringify(memory));runtime.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id,noteId);memoryIds.push(id);
}
await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,noteId,memoryIds,generatedOnly:true}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>{writeFileSync(join(directory,'model-calls.json'),JSON.stringify({modelCalls}));process.exit(modelCalls?1:0);});});
