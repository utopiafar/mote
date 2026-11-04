import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createAgent,parseAnswer} from '../dist/index.js';
import {startBridge} from '../dist/bridge.js';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {contextToolDefinitions} from '../dist/tool-contributions.js';
import {restoreMemoryCoverageKeys} from '../dist/tasks/memory-context.js';

const id='11111111-1111-4111-8111-111111111111',continuationId='22222222-2222-4222-8222-222222222222',declarationId='33333333-3333-4333-8333-333333333333';
const text='Generated diary. I am reviewing 2024 photographs. My friend said: “I will buy a bicycle.” I later repaired my own bicycle. 🌱 End.';
const instruction='These generated records are mainly my diaries, with some calls. Quoted speakers retain their own statements.';
const context={version:1,ownerRelation:'unknown',basis:'default',importDeclarations:[{id:declarationId,version:1,fingerprint:'a'.repeat(64),captureIds:[id]}],importStatements:[{id:declarationId,version:1,instruction,captureIds:[id]}]};
const record={id,deviceId:'generated',capturedAt:'2026-10-12T17:24:50Z',appName:'Generated diary',sourceType:'file',ocrText:text,attributionContext:context,provenance:{sourceId:'generated-import',revision:'generated-1',layer:'original',document:{recordedAt:'2025-02-03T20:45:27+08:00',timeBasis:'recorded',contentRole:'transcript'}}};
const continuation={...record,id:continuationId,ocrText:'Generated continuation: the earlier narrator is reviewing the same 2024 photographs.',attributionContext:{version:1,ownerRelation:'third_party',basis:'owner_material',correction:{version:1,ownerRelation:'third_party'}}};
const target={id,offset:text.indexOf('I later'),length:'I later repaired my own bicycle.'.length};
const grants=[{id,offset:0,length:text.length},{id:continuationId,offset:0,length:continuation.ocrText.length}];
const bounds=(extra={})=>({question:'Inspect the supplied generated diary target.',skill:'memory-extraction',timeZone:'Asia/Shanghai',evidenceIds:[id],evidenceRanges:[target],...extra});
const reader=(records=[record,continuation])=>({search:async()=>{throw Error('Archive discovery must remain unavailable');},timeline:async()=>{throw Error('Archive discovery must remain unavailable');},evidence:async({ids})=>records.filter(record=>ids.includes(record.id)),activity:async()=>({}),devices:async()=>[]});
async function send(bridge,tool,args={}){const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};}
async function fixture(t,extra={},records=[record,continuation]){const bridge=await startBridge(reader(records),bounds(extra),24);t.after(()=>bridge.close());return bridge;}

test('a wholly retired interactive selection denies original reads and discovery before any reader call',async t=>{
 const calls=[];const source={search:async()=>{calls.push('search');return [record];},timeline:async()=>{calls.push('timeline');return [record];},evidence:async()=>{calls.push('evidence');return [record];},activity:async()=>{calls.push('activity');return {};},devices:async()=>{calls.push('devices');return [];}};
 const input={question:'Explain the saved historical answer',executionLane:'interactive',evidenceIds:[],hostRetrieval:'none',historicalSelection:{evidenceIds:[id]},conversation:{turns:[{question:'Saved question',answer:'Saved answer',scope:{evidenceIds:[id]},createdAt:'2026-10-01T00:00:00Z',evidenceUnavailable:true}],omittedTurns:0,historyContext:{conversationId:randomUUID(),revision:2,turns:[{id:randomUUID(),runId:randomUUID()}],evidenceDependencies:{version:1,complete:true,ids:[id]}}}};
 const bridge=await startBridge(source,input,24);t.after(()=>bridge.close());assert.deepEqual(bridge.seedEvidence,[]);assert.deepEqual(taskTools(input),[]);
 for(const [tool,args] of [['evidence',{ids:[]}],['evidence',{ids:[id]}],['evidence',{ids:[continuationId]}],['search_context',{query:'generated'}],['timeline',{}],['context_evidence',{id,offset:0,length:20}],['material_catalog',{}]])assert.equal((await send(bridge,tool,args)).status,400,tool);
 assert.deepEqual(calls,[],'empty selection must never reach a reader that interprets [] as all records');
 await assert.rejects(startBridge(source,{...input,historicalSelection:undefined}),/Invalid extraction evidence scope/);assert.deepEqual(calls,[]);
});

test('legacy bounded sessions retain initial evidence tools and cannot inspect a context catalog',async t=>{
 const bridge=await fixture(t);assert.deepEqual(taskTools(bounds()),['evidence']);
 assert.equal(buildContextEnvelope(bounds(),bridge.seedEvidence).authorizedContextRanges,undefined);
 assert.equal(contextToolDefinitions({question:'ordinary archive'}).some(([name])=>name==='context_evidence'),false);
 assert.equal((await send(bridge,'context_evidence',{id,offset:0,length:20})).status,400);
 assert.equal((await send(bridge,'evidence',{ids:[id],offset:0,length:20})).body.toolError.code,'evidence_range_exceeded');
 assert.deepEqual(bridge.deliveredRanges,[target]);
});

test('a persisted capability manifest cannot resume across an actual contract change',async()=>{
 const saved=JSON.parse(await readFile(new URL('./fixtures/context-capabilities-before-context-reading.json',import.meta.url),'utf8'));
 assert.equal(saved.some(capability=>capability.name==='context_evidence'),false);
 for(const input of [{question:'Resume a persisted archive query'},bounds(),bounds({evidenceReadRanges:grants})])
  await assert.rejects(startBridge(reader(),{...input,contextCapabilitySnapshot:saved},8),error=>error.code==='context_capabilities_changed');
});

test('a broader exact grant exposes only a catalog until successful model-selected original reads',async t=>{
 const input=bounds({evidenceReadRanges:grants}),bridge=await startBridge(reader(),input,12);t.after(()=>bridge.close());
 const envelope=buildContextEnvelope(input,bridge.seedEvidence);
 assert.deepEqual(taskTools(input),['evidence','context_evidence']);assert.deepEqual(envelope.authorizedContextRanges.ranges,grants);
 assert.equal(envelope.untrustedEvidence.length,1);assert.equal(envelope.untrustedEvidence[0].ocrText,text.slice(target.offset,target.offset+target.length));
 const source=envelope.evidenceContexts[envelope.untrustedEvidence[0].commonContextRef];
 assert.equal(source.attributionContext.importStatements[0].instruction,instruction);
 assert.equal(source.contentAt,record.provenance.document.recordedAt);
 assert.equal(bridge.records.has(continuationId),false);assert.deepEqual(bridge.deliveredRanges,[target]);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:`Unread [${continuationId}]`,citationIds:[continuationId]}),bridge.records),/not retrieved/);
 assert.equal((await send(bridge,'evidence',{ids:[continuationId]})).body.toolError.code,'evidence_scope_denied');
 const prefix=await send(bridge,'context_evidence',{id,offset:0,length:48});assert.equal(prefix.status,200);assert.equal(prefix.body.data[0].ocrText,text.slice(0,48));
 const page=await send(bridge,'context_evidence',{id:continuationId,offset:0,length:12000});assert.equal(page.status,200);assert.equal(page.body.data[0].ocrText,continuation.ocrText);
 assert.equal(page.body.data[0].attributionContext.ownerRelation,'third_party');assert.equal(page.body.data[0].textRange.nextOffset,null);
 assert.equal(parseAnswer(JSON.stringify({answer:`Read [${continuationId}]`,citationIds:[continuationId]}),bridge.records).citations.length,1);
 assert.ok(bridge.deliveredRanges.some(range=>range.id===continuationId&&range.length===continuation.ocrText.length));
 assert.equal((await send(bridge,'material_catalog')).status,400);assert.equal((await send(bridge,'search_context')).status,400);
});
test('large exact target and context vectors remain whole without artificial original-count limits',async t=>{
 const generated=(kind,count)=>Array.from({length:count},(_,index)=>{const body=`Generated ${kind} ${index} 🌱`,record={id:randomUUID(),deviceId:'generated',capturedAt:'2026-10-01T00:00:00Z',appName:'Generated short transcript',ocrText:'prefix '+body+' suffix'};return {record,range:{id:record.id,offset:7,length:body.length},member:{key:createHash('sha256').update(kind+index).digest('hex'),id:record.id,offset:7,length:body.length}};});
 const targets=generated('target',200),contexts=generated('context',140),input=bounds({evidenceIds:targets.map(row=>row.record.id),evidenceRanges:targets.map(row=>row.range),evidenceReadRanges:contexts.map(row=>row.range),taskContext:{turns:[],memoryWork:{workContract:'range-evaluation@1',members:targets.map(row=>row.member),contextMembers:contexts.map(row=>row.member),authorizedMembers:[...targets,...contexts].map(row=>row.member)}}});
 const bridge=await startBridge(reader([...targets,...contexts].map(row=>row.record)),input);t.after(()=>bridge.close());
 assert.equal(bridge.seedEvidence.length,200);assert.deepEqual(bridge.deliveredRanges,targets.map(row=>row.range).sort((a,b)=>a.id.localeCompare(b.id)));assert.equal(bridge.records.size,200);
 for(const row of targets)assert.equal(bridge.records.get(row.record.id).ocrText,row.record.ocrText.slice(row.range.offset,row.range.offset+row.range.length));
 const envelope=buildContextEnvelope(input,bridge.seedEvidence),work=envelope.untrustedTaskContext.memoryWork;
 assert.equal(work.members.length,200);assert.equal(work.contextMembers.length,140);assert.equal(work.authorizedMembers.length,340);assert.equal(envelope.authorizedContextRanges.ranges.length,140);
 const coverage=work.members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})),restored=JSON.parse(restoreMemoryCoverageKeys(JSON.stringify({memories:[],coverage}),input.taskContext));
 assert.deepEqual(restored.coverage.map(row=>row.key),targets.map(row=>row.member.key));
 const last=contexts.at(-1);assert.equal(bridge.records.has(last.record.id),false);assert.equal((await send(bridge,'evidence',{ids:[last.record.id]})).body.toolError.code,'evidence_scope_denied');
 const page=await send(bridge,'context_evidence',{id:last.record.id,offset:last.range.offset,length:12000});assert.equal(page.status,200);assert.equal(page.body.data[0].ocrText,last.record.ocrText.slice(last.range.offset,last.range.offset+last.range.length));
 assert.equal((await send(bridge,'context_evidence',{id:last.record.id,offset:last.range.offset+last.range.length,length:1})).body.toolError.code,'evidence_range_exceeded');assert.equal(bridge.seedEvidence.length,200,'context reads never add extraction targets');
});

test('context pagination stops at its grant and respects exact UTF-16 boundaries',async t=>{
 const emoji=text.indexOf('🌱'),grant={id,offset:emoji,length:2},bridge=await fixture(t,{evidenceReadRanges:[grant]});
 assert.equal((await send(bridge,'context_evidence',{id,offset:emoji+1,length:1})).body.toolError.code,'invalid_evidence_range');
 assert.equal((await send(bridge,'context_evidence',{id,offset:emoji,length:1})).body.toolError.code,'invalid_evidence_range');
 const result=await send(bridge,'context_evidence',{id,offset:emoji,length:12000});assert.equal(result.status,200);
 assert.equal(result.body.data[0].ocrText,'🌱');assert.equal(result.body.data[0].textRange.nextOffset,null);assert.deepEqual(result.body.readRange,{offset:emoji,length:2});
 assert.equal((await send(bridge,'context_evidence',{id,offset:emoji+2,length:2})).body.toolError.code,'evidence_range_exceeded');
 assert.deepEqual(bridge.deliveredRanges,[target,grant]);
});

test('host read grants are snapshotted and rejected requests never disclose extra ranges',async t=>{
 const mutable=[{id,offset:0,length:10}],bridge=await fixture(t,{evidenceReadRanges:mutable});mutable[0].length=text.length;mutable.push(grants[1]);
 assert.equal((await send(bridge,'context_evidence',{id,offset:20,length:10})).body.toolError.code,'evidence_range_exceeded');
 assert.equal((await send(bridge,'context_evidence',{id:continuationId,offset:0,length:10})).body.toolError.code,'evidence_range_exceeded');
 assert.equal((await send(bridge,'context_evidence',{id,offset:0,length:10,url:'https://invalid.example'})).body.toolError.code,'invalid_evidence_range');
 assert.deepEqual(bridge.deliveredRanges,[target]);assert.equal(bridge.records.has(continuationId),false);
});

test('an unavailable unread context-only original does not block its independent target or acquire citation authority',async t=>{
 let returned=[record];const source=reader();source.evidence=async({ids})=>returned.filter(record=>ids.includes(record.id));
 const bridge=await startBridge(source,bounds({evidenceReadRanges:grants}),8);t.after(()=>bridge.close());
 assert.deepEqual(bridge.deliveredRanges,[target]);assert.equal(bridge.records.has(continuationId),false);
 assert.equal(parseAnswer(JSON.stringify({answer:`Generated target [${id}]`,citationIds:[id]}),bridge.records).citations[0].id,id);
 const missing=await send(bridge,'context_evidence',{id:continuationId,offset:0,length:10});assert.equal(missing.status,400);assert.equal(missing.body.toolError.code,'evidence_changed');
 returned=[record,continuation];const late=await send(bridge,'context_evidence',{id:continuationId,offset:0,length:10});assert.equal(late.status,400,'a later original cannot replace the unavailable frozen pin');assert.equal(late.body.toolError.code,'evidence_changed');
 assert.deepEqual(bridge.deliveredRanges,[target]);assert.equal(bridge.records.has(continuationId),false);
});

for(const change of ['body','attribution','source','authorization'])test(`fresh ${change} changes reject context and initial evidence re-reads`,async t=>{
 let current=structuredClone(record),available=true;const source=reader();source.evidence=async({ids})=>available&&ids.includes(id)?[current]:[];
 const bridge=await startBridge(source,bounds({evidenceReadRanges:[grants[0]]}),10);t.after(()=>bridge.close());
 if(change==='body')current.ocrText+=' altered';
 if(change==='attribution')current.attributionContext={version:1,ownerRelation:'third_party',basis:'owner_material',correction:{version:2,ownerRelation:'third_party'}};
 if(change==='source')current.provenance.sourceId='changed-source';
 if(change==='authorization')available=false;
 for(const [tool,args] of [['context_evidence',{id,offset:0,length:20}],['evidence',{ids:[id]}]]){const result=await send(bridge,tool,args);assert.equal(result.status,400);assert.equal(result.body.toolError.code,'evidence_changed');assert.equal(result.body.toolError.recovery,'stop');}
 assert.deepEqual(bridge.deliveredRanges,[target]);
});

test('context pages retain the full requested authorized range beyond retired character quotas',async t=>{
 const long={...record,ocrText:'Generated '.repeat(3000)},initial={id,offset:15000,length:10000},grant={id,offset:0,length:12000};
 const bridge=await startBridge(reader([long]),bounds({evidenceRanges:[initial],evidenceReadRanges:[grant]}));t.after(()=>bridge.close());
 for(let i=0;i<20;i++)assert.equal((await send(bridge,'evidence',{ids:[id]})).status,200);
 const result=await send(bridge,'context_evidence',{id,offset:0,length:12000});assert.equal(result.status,200);assert.equal(result.body.data[0].ocrText.length,12000);assert.equal(result.body.data[0].textRange.nextOffset,null);
 assert.ok(bridge.deliveredCharacters>160000);assert.deepEqual(bridge.deliveredRanges,[grant,initial]);
 const outside=await send(bridge,'context_evidence',{id,offset:12000,length:1});assert.equal(outside.status,400);assert.equal(outside.body.toolError.code,'evidence_range_exceeded');
});

test('the Codex adapter supplies the host delivery receipt before validation and ignores forged model receipts',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-context-read-codex-')),executable=join(root,'generated-codex.mjs');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused-key'}),{mode:0o600});
 await writeFile(executable,`#!${process.execPath}
import readline from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
else if(m.method==='thread/start'){if(m.params.dynamicTools.some(t=>!['evidence','context_evidence','skill'].includes(t.name)))process.exit(4);send({id:m.id,result:{thread:{id:'generated-thread',model:null},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});}
else if(m.method==='turn/start'){const envelope=JSON.parse(m.params.input[0].text);if(envelope.untrustedEvidence.some(r=>r.id===${JSON.stringify(continuationId)}))process.exit(5);send({id:m.id,result:{turn:{id:'generated-turn'}}});send({id:999,method:'item/tool/call',params:{threadId:'generated-thread',tool:'context_evidence',namespace:null,arguments:{id:${JSON.stringify(continuationId)},offset:0,length:12000}}});}
else if(m.id===999){if(!m.result.success)process.exit(6);send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-message',type:'agentMessage',text:JSON.stringify({answer:'Read generated continuation [${continuationId}]',citationIds:[${JSON.stringify(continuationId)}],evidenceReadRanges:[{id:'model-forged',offset:0,length:999999}]})}}});send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'completed'}}});}
});
`,{mode:0o700});
 const agent=createAgent({reader:reader(),protocol:'codex-app-server',model:'generated-model',codex:{executable,home:root},agentTimeoutMs:10000});t.after(()=>agent.close());let validated;
 const answer=await agent.query(bounds({evidenceReadRanges:grants,validateOutput:value=>{validated=value.evidenceReadRanges;assert.deepEqual(value.evidenceReadRanges,[target,{id:continuationId,offset:0,length:continuation.ocrText.length}]);}}));
 assert.deepEqual(answer.evidenceReadRanges,validated);assert.equal(answer.citations[0].id,continuationId);assert.equal(answer.evidenceReadRanges.some(range=>range.id==='model-forged'),false);
});
