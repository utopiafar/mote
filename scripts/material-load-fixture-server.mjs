/** Isolated generated server for test-material-load-ui; no live provider or personal data. */
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../apps/server/dist/app.js';
import {Conversations} from '../apps/server/dist/conversations.js';
const {config,fixturePath,ready}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const fixture=JSON.parse(readFileSync(fixturePath,'utf8')),interactive=fixture.profile==='interactive-400',calls=[],ticks=[];
// Provider code receives only this explicit factory. Fail closed for all outbound fetches.
const actualFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Non-loopback request prohibited in generated fixture');return actualFetch(input,init);};
let node;
node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:interactive,close:async()=>{},query:async input=>{
 if(!interactive||!input.traceContext?.jobId)throw Error('Unexpected query in generated UI fixture');
 if(calls.length>=fixture.expectations.stubCallLimit)throw Error('Frozen stub call budget exceeded');
 const job=node.memoryPipeline.get(input.traceContext.jobId),batch=job.batches.find(b=>b.id===input.traceContext.batchId);
 const recipe=batch?.strategy.recipe.id;
 if(!['fixture.body-memory','fixture.transcript-memory'].includes(recipe))throw Error('Unexpected recipe');
 const visible=await reader.evidence({ids:input.evidenceIds});if(visible.length!==input.evidenceIds.length)throw Error('Fixture input unreadable');
 const evidence=node.memories.readEvidence(input.evidenceIds)[0],id=evidence.id;
 calls.push({recipe,jobId:job.id,phase:input.traceContext.phase,evidenceIds:input.evidenceIds,at:Date.now()});
 return {answer:JSON.stringify({memories:[{domain:'personal',title:'合成正文记忆',statement:'Generated body records a preference for written checklists. ['+id+']',uncertainty:'Generated fixture only.',admission:{layer:'memory',reason:'Generated explicit owner preference',scope:'Generated fixture',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]}]}),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()};
}})});
// Model selection is a separate provider capability from query(); keep both local and generated.
node.app.addHook('onRequest',async(req,reply)=>{if(req.method==='GET'&&/^\/api\/model-settings\/profiles\/[^/?]+\/models$/.test(req.url))return reply.send({items:[{id:'fixture',name:'Generated fixture'}]});});
const lifecycle=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'])lifecycle[key].enabled=false;node.lifecycle.configure(lifecycle);
let peakRss=0,controlRecord,controlState='pending';const sample=setInterval(()=>peakRss=Math.max(peakRss,process.memoryUsage().rss),100);
function controlDraft(record){const c=fixture.control;return {id:c.materialId,kind:'mote.message',schemaVersion:1,title:c.title,origin:{sourceId:c.sourceId,externalId:c.externalId,deviceId:c.deviceId,firstAt:c.observedAt,lastAt:c.observedAt},members:[{id:'original',kind:'capture',ref:'capture:'+record.id}],blocks:[{id:'body',kind:'text',format:'plain',text:c.body,memberIds:['original']},...(controlState==='ready'?[{id:'transcript',kind:'text',format:'transcript',text:c.transcript,memberIds:['original']}]:[])],artifacts:[{key:'source-body',state:'ready',revision:'body-v1',blockIds:['body']},{key:'extracted-text',state:controlState,revision:controlState+'-v1',blockIds:controlState==='ready'?['transcript']:[]}],coverage:{state:controlState==='ready'?'complete':'partial'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};}
if(interactive){
 const c=fixture.control;
 node.materialOrganizer.registry.register({id:'fixture.ui-controlled',version:'1',slot:'source-item',priority:100,exclusive:true,select:r=>r.provenance?.sourceId===c.sourceId?{sourceId:c.sourceId,externalId:c.externalId}:undefined,identity:()=>c.materialId,build:reader=>{const r=reader.sourceHead();return r?controlDraft(r):undefined;}});
 for(const [id,requires] of [['fixture.body-memory',['source-body']],['fixture.transcript-memory',['extracted-text']]])node.memoryStrategies.registerRecipe({id,version:'1',requires,extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.personal-review',version:'2'}});
 node.sources.register({id:c.sourceId,name:'生成的受控处理资料',kind:'custom',deviceId:c.deviceId,platform:'import'});
 controlRecord=await node.sources.upsert(c.sourceId,{externalId:c.externalId,revision:'1',observedAt:c.observedAt,title:c.title,kind:'message',layer:'original',text:c.body+' '+c.transcript});
 await node.materialOrganizer.tick(200);
}
const catalog=()=>node.store.db.prepare('SELECT id FROM material_heads WHERE retired=0').all().map(row=>{const m=node.materials.get(row.id);return {id:m.id,ref:m.ref,title:m.title,kind:m.kind,revision:m.revision};});
const state=()=>({count:catalog().length,catalog:catalog(),peakRss,calls,ticks,jobs:node.memoryPipeline.list().map(job=>({...node.memoryPipeline.get(job.id),operation:node.store.db.prepare('SELECT state FROM operation_progress WHERE id=?').get('memory:'+job.id)})),control:interactive?{recordId:controlRecord.id,material:node.materials.get(fixture.control.materialId)}:undefined});
node.app.post('/api/fixture/configure',async()=>node.sourcePipelines.configure('generated-load',{settleSeconds:0,memory:false}));
node.app.post('/api/fixture/drain',async()=>{const start=Date.now(),beforeCount=catalog().length;await node.sourcePipelines.tick(100);await node.materialOrganizer.tick(200);ticks.push({start,end:Date.now(),beforeCount,afterCount:catalog().length});return state();});
node.app.get('/api/fixture/state',async()=>state());
node.app.post('/api/fixture/transcript',async()=>{controlState='ready';const prior=node.materials.get(fixture.control.materialId);node.materials.publish(controlDraft(controlRecord),{expectedRevision:prior.revision});node.memoryPipeline.wakeInputs([fixture.control.materialId]);await node.memoryPipeline.tickInputs();return state();});
node.app.post('/api/fixture/conversation',async req=>{
 const record=fixture.records.find(r=>r.index===req.body.index&&r.long);if(!record)throw Error('Unknown generated long source');
 const material=node.materials.get(record.materialId);if(!material)throw Error('Material missing');
 const result=new Conversations(node.store).append(undefined,{question:'合成引用对话',timeZone:'UTC'},{answer:'生成资料的完整原文有来源可查。['+material.ref+']',citations:[{id:material.ref,capturedAt:record.item.observedAt,appName:record.title,excerpt:record.item.text.slice(0,180)}],trace:[],runId:randomUUID()});
 return {materialRef:material.ref,recordId:node.store.db.prepare('SELECT capture_id FROM source_heads WHERE source_id=? AND external_id=?').get(record.sourceId,record.item.externalId)?.capture_id,conversation:result};
});
await node.app.listen({host:'127.0.0.1',port:0});writeFileSync(ready+'.tmp',JSON.stringify({url:node.app.listeningOrigin}),{mode:0o600});renameSync(ready+'.tmp',ready);
process.once('SIGTERM',async()=>{clearInterval(sample);await node.app.close();process.exit(0);});
