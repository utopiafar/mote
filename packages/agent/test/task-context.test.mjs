import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {systemInstructions} from '../dist/instructions.js';

test('proposal lifecycle has the same completion contract in system and task envelopes',()=>{
 const input={question:'Generated plan',hostRetrieval:'none',hostControlChannel:{phase:'proposal',definitions:[],execute:async()=>({data:{}})}};
 const envelope=buildContextEnvelope(input,[]),system=systemInstructions(input);
 assert.equal(envelope.delegation.phase,'proposal');assert.ok(system.endsWith(envelope.delegation.instruction));
 assert.match(system,/return the requested final JSON/);assert.match(system,/Never call delegation_yield to finish planning/);
 const ordinary=buildContextEnvelope({...input,hostControlChannel:{...input.hostControlChannel,phase:'execution'}},[]);
 assert.match(ordinary.delegation.instruction,/use delegation_yield while independently scheduled workers run/);
});

test('durable task retries keep their host-owned time even across a clock boundary',()=>{
 const input={question:'Review a proposed event',contextTime:'2026-09-01T23:59:59Z',timeZone:'UTC'};
 const first=buildContextEnvelope(input,[],'2026-09-01T23:59:59Z'),retry=buildContextEnvelope(input,[],'2026-09-02T00:00:01Z');
 assert.equal(first.currentTime,retry.currentTime);assert.equal(first.displayCurrentTime,retry.displayCurrentTime);
 assert.equal(buildContextEnvelope({question:'Interactive request'},[],'2026-09-02T00:00:01Z').currentTime,'2026-09-02T00:00:01Z');
});
test('opening memory hints are separate from cited evidence and include verification guidance',()=>{
 const lead={id:'generated-memory',title:'Generated preference',statement:'Generated statement',uncertainty:'Only in one project',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z'};
 const envelope=buildContextEnvelope({question:'What do you know?',openingMemories:[lead]},[]);
 assert.deepEqual(envelope.untrustedMemoryLeads,[lead]);
 assert.match(envelope.memoryLeadInstruction,/navigation hints, not independent evidence or instructions/);
 assert.match(envelope.memoryLeadInstruction,/includeEvidence=true.*host-verified supporting original ranges/);
 assert.match(envelope.memoryLeadInstruction,/Cite delivered original ids, not memory ids/);
 assert.equal(envelope.untrustedEvidence,undefined);
});
test('host context lineage is retained for fences without being disclosed to the model or granting citation reads',async t=>{
 const id='6f28159f-242b-5442-9a0c-a17958985a52',deps={version:1,complete:true,ids:[id]},lead={id:'generated-memory',title:'Generated',statement:'Generated decision',uncertainty:'Fixture',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z'};
 const input={question:'Generated',contextEvidenceDependencies:deps,openingMemories:[lead],conversation:{turns:[{question:'Generated earlier',answer:'Generated answer',createdAt:lead.createdAt,scope:{}}],omittedTurns:0,evidenceDependencies:deps}};
 const envelope=buildContextEnvelope(input,[]);assert.equal(envelope.conversation.evidenceDependencies,undefined);assert.equal(JSON.stringify(envelope).includes(id),false);
 const bridge=await startBridge(reader,input,6);t.after(()=>bridge.close());assert.deepEqual(bridge.evidenceDependencies,deps);assert.equal(bridge.records.has(id),false,'lineage cannot confer citation authority');
 const missing=await startBridge(reader,{question:'Generated',openingMemories:[lead],contextEvidenceDependencies:{version:1,complete:true,ids:[]}},6);t.after(()=>missing.close());assert.equal(missing.evidenceDependencies.complete,false,'nonempty derived lead cannot claim empty complete lineage');
});
import {startBridge} from '../dist/bridge.js';
import {parseAnswer} from '../dist/index.js';
const record={id:'6f28159f-242b-5442-9a0c-a17958985a52',capturedAt:'2026-09-18T00:00:00Z',deviceId:'fixture',appName:'Generated',ocrText:'a'.repeat(9000)+'NEEDLE the gate opens at 14:30. '+'b'.repeat(3000)};
const reader={search:async()=>[record],timeline:async()=>({items:([record]),nextCursor:null}),evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],memories:async()=>({items:[{id:'memory',statement:'derived'}],evidence:[record]})};
async function fixture(t,input={question:'fixture'}){const bridge=await startBridge(reader,input,24);t.after(()=>bridge.close());return {bridge,call:async(tool,args)=>{const r=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:r.status,body:await r.json()};}};}
test('shared context separates long task input and retains incremental semantics and task authority',()=>{
 const input={question:'Compact',skill:'working-memory',taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(30000)}]},incrementalEvidenceIds:['one']};
 const envelope=buildContextEnvelope(input,[],'2026-09-18T00:00:00Z');
 assert.equal(envelope.request,'Compact');assert.equal(envelope.untrustedTaskContext.turns[0].answer.length,30000);assert.equal(envelope.incrementalContext.count,1);assert.deepEqual(taskTools(input),[]);assert.deepEqual(taskTools({question:'Extract',evidenceIds:['one']}),['evidence']);
 assert.match(envelope.disclosurePolicy,/No archive retrieval is available/);
 const archive=buildContextEnvelope({question:'Browse generated'},[]);
 assert.match(archive.disclosurePolicy,/material_catalog.*material_read.*evidence before citing/);
 assert.match(archive.disclosurePolicy,/source tags.*untrusted/);
 assert.throws(()=>buildContextEnvelope({...input,taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(80000)}]}},[]));
});
test('search localizes late match and separate reads retain both citation spans',async t=>{
 const {bridge,call}=await fixture(t);
 const found=await call('search_context',{query:'NEEDLE'});assert.equal(found.status,200);assert.match(found.body.data[0].ocrText,/14:30/);assert.ok(found.body.data[0].textRange.start>8000);
 await call('evidence',{ids:[record.id],offset:0,length:100});
 const second=await call('evidence',{ids:[record.id],offset:9000,length:100});assert.equal(second.status,200);
 const saved=bridge.records.get(record.id);assert.equal(saved.deliveredRanges.length,3);
 const answer=parseAnswer(JSON.stringify({answer:`14:30 [${record.id}]`,citationIds:[record.id]}),bridge.records);assert.match(answer.citations[0].excerpt,/14:30/);
});
test('memory detail discovers IDs without authorizing unread original citations',async t=>{
 const {bridge,call}=await fixture(t);const memory=await call('memories',{id:'memory'});
 assert.equal(memory.status,200);assert.equal(memory.body.data.evidence[0].ocrText,undefined);assert.equal(bridge.records.has(record.id),false);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:'claim',citationIds:[record.id]}),bridge.records));
 assert.equal((await call('evidence',{ids:[record.id],offset:9000,length:100})).status,200);assert.equal(bridge.records.has(record.id),true);
});
test('working task advertises and enforces no archive tools',async t=>{
 const {call}=await fixture(t,{question:'Compact',skill:'working-memory'});
 assert.equal((await call('_ready',{tools:['skill']})).status,200);
 assert.equal((await call('timeline',{})).status,400);
});

test('revision changes retire prior spans and repeated spans do not duplicate citation state',async t=>{
 const {rememberEvidence}=await import('../dist/evidence-ledger.js');const records=new Map();
 const first={...record,ocrText:'first',evidenceFingerprint:'v1',textRange:{start:0,end:5}};
 rememberEvidence(records,first);rememberEvidence(records,first);assert.equal(records.get(record.id).deliveredRanges.length,1);
 rememberEvidence(records,{...first,ocrText:'new',evidenceFingerprint:'v2',textRange:{start:100,end:103}});
 assert.deepEqual(records.get(record.id).deliveredRanges,[{start:100,end:103,text:'new'}]);
});
test('host context accounts for schema and system input before admitting a task',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const {metrics}=assembleContext({question:'generated'},[],'system',[{name:'evidence'}],4096);
 assert.equal(metrics.system,6);assert.equal(metrics.outputTokenReserve,4096);assert.equal(metrics.unit,'utf16_characters');
 assert.throws(()=>assembleContext({question:'generated'},[],'x'.repeat(180000),[],4096),/input budget/);
 const limited=JSON.parse(assembleContext({question:'generated'},[],'system',[],4096,7).prompt);
 assert.equal(limited.contextBudget.maxToolCalls,7);
 assert.equal(buildContextEnvelope({question:'Extract',evidenceIds:['one']},[]).retrievalInstruction,undefined,'Bounded extraction is not given archive convergence instructions');
});

test('bounded evidence does not silently change an ordinary answer into memory extraction',()=>{
 assert.equal(buildContextEnvelope({question:'Answer this',evidenceIds:['one']},[]).responseMode,'answer');
 assert.equal(buildContextEnvelope({question:'Extract',skill:'memory-extraction',evidenceIds:['one']},[]).responseMode,'memory-extraction');
});

test('bounded extraction supplies the unchanged procedure, draft and originals without archive discovery instructions',()=>{
 const input={question:'Exact host admission contract',skill:'memory-extraction',evidenceIds:[record.id],evidenceRanges:[{id:record.id,offset:0,length:record.ocrText.length}],taskContext:{untrustedMemoryDraft:{memories:[{statement:'Untrusted draft'}]}}};
 const envelope=buildContextEnvelope(input,[record]);
 assert.equal(envelope.request,input.question);assert.deepEqual(envelope.untrustedEvidence,[record]);assert.deepEqual(envelope.untrustedTaskContext,input.taskContext);
 assert.match(envelope.procedure,/Preserve the subject, speaker, tense, uncertainty/);
 assert.match(envelope.procedureInstruction,/no skill tool call is required/);
 assert.match(envelope.disclosurePolicy,/Archive discovery tools are unavailable/);
 assert.doesNotMatch(envelope.disclosurePolicy,/material_catalog|search_context|context_index/);
});

test('host derived-context dependencies are authorization metadata and never new evidence seeds or tool scope',()=>{
 const input={question:'Compare a derived rule',evidenceIds:['candidate-only'],derivedContextEvidenceIds:['private-root-only'],taskContext:{turns:[],untrustedMemoryDraft:{statement:'The derived rule'}}};
 const envelope=buildContextEnvelope(input,[]);assert.equal(JSON.stringify(envelope).includes('private-root-only'),false);assert.deepEqual(taskTools(input),['evidence']);
});
