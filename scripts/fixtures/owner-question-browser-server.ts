/** Generated source -> real Memory review -> owner control-plane browser fixture. */
import assert from 'node:assert/strict';
import {buildApp} from '../../apps/server/src/app.js';
import type {Config} from '../../apps/server/src/config.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {MemoryWorkMember} from '../../apps/server/src/memory-work-contract.js';
import {fixtureMemoryPlan} from '../../apps/server/test/fixtures/memory-planning.js';

const original='说话人1：我觉得工作压力很大。说话人1：可以讲讲发生什么了吗？参与者：我是林岚。';
const config:Config={dataDir:process.env.MOTE_FIXTURE_DIR!,token:process.env.MOTE_FIXTURE_TOKEN!,dataKey:process.env.MOTE_FIXTURE_TOKEN!,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,memoryConcurrency:1,logLevel:'silent'};
const result=(answer:unknown):QueryResult=>({runId:'generated-browser-model',answer:JSON.stringify(answer),citations:[],trace:[]});
const generate=async(input:QueryInput):Promise<QueryResult>=>{
 if(input.taskContext?.ownerClarificationReply)return result({disposition:'followup',prompt:'请指出这份资料中哪一句话属于你。'});
 const plan=await fixtureMemoryPlan(input);if(plan)return plan;
 const members=(input.taskContext?.memoryWork as {members:MemoryWorkMember[]}|undefined)?.members;assert.ok(members);
 return result({memories:[],capacity:{saturated:false},coverage:members.map(member=>({key:member.key,state:member.attributionContext?.ownerStatements?.length?'no_candidates':'needs_owner_input',candidateIndexes:[],...(member.attributionContext?.ownerStatements?.length?{reason:'The generated review preserves uncertainty.'}:{question:{prompt:'讲述工作压力的是你吗？',reason:'说话标签包含提问和讲述，全文没有可靠的身份对应。',evidence:[{id:member.id,quote:'我觉得工作压力很大。'}],choices:[{id:'narrator',label:'我是讲述者',answer:'这份资料里，讲述工作压力的是我。'},{id:'responder',label:'我是回应的人',answer:'这份资料里，我是回应和提问的人。'},{id:'neither',label:'我没参与',answer:'我没有参与这段对话。'}]}})}))});
};
const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:generate},createModelAgent:async()=>({configured:true,close:async()=>{},query:generate})};
const node=await buildApp(config,dependencies);await node.app.ready();
const settings=node.lifecycle.settings();for(const id of ['working','consolidation','insights'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);
const api=(method:'GET'|'POST'|'PUT',url:string,payload?:Record<string,unknown>)=>node.app.inject({method,url,payload,headers:{authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'}});
assert.equal((await api('POST','/api/sources',{id:'generated-dialogues',name:'Generated browser conversations',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'})).statusCode,200);
const questions:any[]=[];
for(const index of [0,1]){
 const externalId='generated-'+index;
 const response=await api('PUT','/api/sources/generated-dialogues/items',{externalId,revision:'1',observedAt:'2026-09-01T00:00:00Z',kind:'message',layer:'original',text:original,document:{contentRole:'transcript',recordedAt:'2026-09-01T00:00:00Z',timeBasis:'recorded'}});assert.equal(response.statusCode,200,response.body);
 await node.materialOrganizer.tick();await node.sourcePipelines.tick();
 const material=node.materials.list({sourceId:'generated-dialogues'}).items.find(value=>value.origin.externalId===externalId)!;assert.ok(material);
 const started=await api('POST','/api/memory-jobs',{evidenceIds:node.materials.evidenceIds(material.ref),recipes:[{id:'mote.personal-memory',version:'2'}]});assert.equal(started.statusCode,202,started.body);
 const job=await node.memoryPipeline.run(started.json().id);assert.equal(job.status,'waiting_for_input');
 const page=await api('GET','/api/owner-questions?operationId='+encodeURIComponent('memory:'+job.id));assert.equal(page.statusCode,200,page.body);
 const question=page.json().items[0];assert.ok(question);questions.push({id:question.id,materialId:question.materialId,materialRef:question.materialRef,operationId:question.operationId,workId:question.workId});
}
await node.app.listen({host:'127.0.0.1',port:0});process.send?.({ready:true,endpoint:node.app.server.address()&&'http://127.0.0.1:'+(node.app.server.address() as {port:number}).port,questions});
process.on('SIGTERM',()=>void node.app.close().then(()=>process.exit(0)));
