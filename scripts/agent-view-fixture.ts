/** Dedicated generated-only browser fixture. No model or personal archive access. */
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import {buildContextEnvelope} from '@mote/agent';
import {openingMemories} from '../apps/server/src/opening-memory.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const token=randomBytes(32).toString('hex');
const runtime=await buildApp({dataDir:join(directory,'data'),dataKey:undefined,token,tokenPath:'generated-token',host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentTraceEnabled:true},{agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
const id=randomUUID(),text='Generated personal note: use explicit evidence. '+Array.from({length:250},(_,i)=>`Generated line ${i}: bounded original content.`).join('\n')+'\nGENERATED_FINAL_LINE';
await runtime.store.ingest({id,deviceId:'fixture-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:text});
const quote=text.slice(0,44),memory=runtime.memories.extract({answer:JSON.stringify({memories:[{title:'Generated memory lead',statement:'Use explicit evidence.',uncertainty:'Generated fixture only.',evidenceIds:[id],evidence:[{id,quote}],admission:{layer:'memory',reason:'Explicit authored preference',scope:'Generated fixture',attribution:'user'}}]}),citations:[{id,capturedAt:new Date().toISOString(),appName:'Generated note',excerpt:quote}],trace:[],runId:randomUUID()},'synthetic-fixture').items[0];runtime.memories.publish(memory.id);
for(let i=0;i<17;i++){
 const sourceId='fixture-source-'+String(i).padStart(2,'0');runtime.sources.register({id:sourceId,name:'Generated source '+i,kind:'local-files',deviceId:i===16?'other-device':'fixture-device',platform:'import'});
 await runtime.sources.upsert(sourceId,{externalId:'item',revision:'1',observedAt:new Date().toISOString(),kind:'file',layer:'original',title:'Generated file '+i,text:i===0?text:'Generated file text '+i});
}
const runId=randomUUID(),leads=await openingMemories(runtime.featureServices.archiveReader,'Generated question',{}),context=buildContextEnvelope({question:'Generated question',openingMemories:leads},[]);
runtime.diagnostics.agentTrace({type:'context.assembled',runId,payload:{prompt:JSON.stringify(context)}},{});
runtime.diagnostics.agentTrace({type:'tool.started',runId,tool:'evidence',payload:{arguments:{ids:[id],offset:4000,length:4000}}},{});
runtime.diagnostics.agentTrace({type:'tool.completed',runId,tool:'evidence',status:'succeeded',payload:{result:[{id,ocrText:text.slice(4000,8000),textRange:{offset:4000,total:text.length}}]}},{});
runtime.diagnostics.agentTrace({type:'run.completed',runId,status:'succeeded',payload:{citations:[id]}},{});
runtime.app.get('/__fixture-bootstrap',async(_req,reply)=>reply.type('text/html').send('<!doctype html><html><body>Generated fixture bootstrap</body></html>'));
await runtime.diagnostics.flush();await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,runId,evidenceId:id,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
