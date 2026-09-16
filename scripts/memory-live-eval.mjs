import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startCodexRelay} from './codex-relay.mjs';
import {seedMemoryFixtures} from './memory-fixtures.ts';
import {parseAnswer} from '@mote/agent';
import {Store} from '../apps/server/src/store.ts';
import {buildApp} from '../apps/server/src/app.ts';
import {createModelAgent} from '../apps/server/src/model-agent.ts';
import {Conversations} from '../apps/server/src/conversations.ts';

const directory=await mkdtemp(join(tmpdir(),'mote-memory-live-generated-')),store=new Store(directory),started=Date.now();
const report={generatedAt:new Date().toISOString(),model:'gpt-5.6-luna',effort:'max',transport:'local Codex App Server → loopback adapter → DeepSeek Harness',fixture:null,checks:[],calls:[],physicalDeviceTested:false,personalDataUsed:false};
let relay,node;
try{
  const fixture=await seedMemoryFixtures(store);report.fixture=fixture.counts;console.log('Seeded',fixture.counts);
  relay=await startCodexRelay({maxCalls:20,onCall:call=>{report.calls.push(call);console.log('MODEL',JSON.stringify({...call,toolCalls:undefined,content:call.content?'[saved in synthetic report]':undefined}));}});
  node=await buildApp({dataDir:directory,token:'generated-live-fixture',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:100000000,maxExportBytes:10000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],modelProvider:'openai',modelProtocol:'openai-completions',model:relay.model,modelBaseUrl:relay.baseUrl,apiKey:relay.apiKey,allowUnauthenticatedLocal:false,modelReasoningEffort:'max',modelMaxTokens:32768,modelTimeoutMs:600000,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false},{store,createModelAgent:async(settings,reader)=>{const runtime=await createModelAgent(settings,reader);return {configured:runtime.configured,close:()=>runtime.close(),query:async input=>{try{return await runtime.query(input);}catch(error){console.error('HARNESS',error.name,error.message,error.reason);throw error;}}};}});
  const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'])settings[key].enabled=false;node.lifecycle.configure(settings);
  const anchorIds=['preference-old','preference-new','procedure','cancel'].map(key=>fixture.anchors[key]);
  let job;
  if(process.env.MOTE_MEMORY_REPLAY_EXTRACTION){const captured=JSON.parse(await readFile(process.env.MOTE_MEMORY_REPLAY_EXTRACTION,'utf8')),sample=captured.calls.find(c=>c.content);assert.equal(captured.model,relay.model);assert.equal(captured.effort,'max');const parsed=parseAnswer(sample.content,new Map(anchorIds.map(id=>[id,store.evidence([id])[0]])));const saved=node.memories.extract({...parsed,trace:[],runId:randomUUID()},relay.model,{skillVersion:'memory-extraction@1.1.0'});job={status:'completed',memoryIds:saved.items.map(m=>m.id)};report.extractionGeneration='Previously captured live output, replayed after fixing stream timeout; not a new model generation';}
  else job=await node.memoryPipeline.run(node.memoryPipeline.create({evidenceIds:anchorIds,timeZone:'Asia/Shanghai'}).id);
  assert.equal(job.status,'completed',JSON.stringify(job));assert.ok(job.memoryIds.length>=3);report.checks.push({name:'extraction',status:'passed',records:anchorIds.length,candidates:job.memoryIds.length,memories:job.memoryIds.map(id=>node.memories.get(id))});console.log('PASS extraction',job.memoryIds.length);
  // Independent procedure, same Harness/read-only bridge. Model reads source memory
  // cards, searches originals and proposes durable text rather than overwriting them.
  const p=node.lifecycle.settings();
  if(process.env.MOTE_MEMORY_REPLAY_CONSOLIDATION){
    const captured=JSON.parse(await readFile(process.env.MOTE_MEMORY_REPLAY_CONSOLIDATION,'utf8'));assert.equal(captured.model,relay.model);assert.equal(captured.effort,'max');
    const sample=captured.calls.find(c=>c.content&&c.index===4);const parsed=parseAnswer(sample.content,new Map(anchorIds.map(id=>[id,store.evidence([id])[0]])));
    node.memories.extract({...parsed,trace:[],runId:randomUUID()},relay.model,{tier:'consolidated',relatedMemoryIds:job.memoryIds,skillVersion:'memory-consolidation@1.0.0'});
    report.consolidationGeneration='Previously successful live consolidation replayed to avoid repeat model calls';
  }else{
    p.consolidation={enabled:true,intervalHours:1/60,minChanges:1,maxItems:30};node.lifecycle.configure(p);
    store.db.prepare("UPDATE memory_lifecycle_state SET json=json_set(json,'$.lastSuccess',0) WHERE id='consolidation'").run();await node.lifecycle.tick();
    const state=node.lifecycle.view().extensions.find(e=>e.id==='consolidation');assert.equal(state.failures,0,JSON.stringify(state));assert.ok(state.lastRun);
  }
  const consolidated=node.memories.page({tier:'consolidated',level:'detail'}).items;assert.ok(consolidated.length>=1);report.checks.push({name:'consolidation',status:'passed',items:consolidated});console.log('PASS consolidation',consolidated.length);
  p.consolidation.enabled=false;node.lifecycle.configure(p);
  const result=await node.agent.query({question:'请先用 memories 全文检索；没有支持某项问题的记忆时必须用 search_context 搜索原始资料，不要只在 memories 中重复查找。请核对：青岚项目从3月到8月的数据库选择是否变化、当前是什么？灯塔4月12日的验证是否完成？林岚的清晨开会偏好能算成陈禾的吗？请保留每个结论的原始引用。只回答这三个问题。',timeZone:'Asia/Shanghai'});
  report.queryResult=result;
  const cited=new Set(result.citations.map(c=>c.id));assert.ok(cited.has(fixture.anchors['preference-new']));assert.ok(cited.has(fixture.anchors.cancel));assert.ok(cited.has(fixture.anchors['other-person']));assert.ok(result.trace.some(t=>t.tool==='memories'));report.checks.push({name:'cross-month-fts-attribution-cancellation',status:'passed',result});console.log('PASS cross-month query');
  const conversations=new Conversations(store);let id;for(let i=0;i<18;i++){const created=conversations.append(id?conversations.get(id):undefined,{question:i===0?'只使用生成数据测试，不用真实截图。':i===4?'把预算改成最多20次模型调用，3万条改为480条。':`合成跟进 ${i}`},{answer:'已记录这个合成测试约束。',citations:[],trace:[],runId:randomUUID()});id=created.conversationId;}
  await node.working.compact(id,node.lifecycle.settings(),input=>node.agent.query(input));const summary=node.working.get(conversations.get(id));assert.ok(summary?.text);report.checks.push({name:'working-summary',status:'passed',summary});console.log('PASS working memory');
  p.insights={enabled:true,intervalHours:1/60,minChanges:1,maxItems:12};node.lifecycle.configure(p);
  store.db.prepare("UPDATE memory_lifecycle_state SET json=json_set(json,'$.lastSuccess',0) WHERE id='insights'").run();await node.lifecycle.tick();
  const insightState=node.lifecycle.view().extensions.find(e=>e.id==='insights');assert.equal(insightState.failures,0,JSON.stringify(insightState));assert.ok(store.insights().length);report.checks.push({name:'incremental-insight',status:'passed',result:store.insights()[0]});console.log('PASS incremental insight');
  const dependent=node.memories.page({level:'detail'}).items.filter(m=>m.evidenceIds.includes(fixture.anchors['preference-new']));store.delete(fixture.anchors['preference-new']);for(const memory of dependent)assert.throws(()=>node.memories.get(memory.id));assert.equal(store.insights().length,0);assert.equal(node.working.get(conversations.get(id)),undefined);report.checks.push({name:'derived-data-privacy-invalidation',status:'passed',removedMemories:dependent.length});
  report.status='passed';
}catch(error){report.status='failed';report.error=String(error);console.error(error);process.exitCode=1;}
finally{report.elapsedSeconds=Math.round((Date.now()-started)/1000);if(node)await node.app.close();await relay?.close();store.close();await writeFile(process.env.MOTE_MEMORY_REPORT??'/private/tmp/mote-memory-live-report.json',JSON.stringify(report,null,2));await rm(directory,{recursive:true,force:true});console.log('REPORT',report.status,report.elapsedSeconds,'seconds',report.calls.length,'calls');}
