import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ARCHIVE_RECENCY_INSTRUCTIONS,buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {systemInstructions} from '../dist/instructions.js';

test('proposal lifecycle has one instruction contract while the envelope supplies only host state',()=>{
 const input={question:'Generated plan',hostRetrieval:'none',hostControlChannel:{phase:'proposal',definitions:[],execute:async()=>({data:{}})}};
 const envelope=buildContextEnvelope(input,[]),system=systemInstructions(input);
 assert.equal(envelope.delegation.phase,'proposal');assert.equal(envelope.delegation.instruction,undefined);
 assert.match(system,/return the requested final JSON/);assert.match(system,/Never call delegation_yield to finish planning/);
 const ordinary=systemInstructions({...input,hostControlChannel:{...input.hostControlChannel,phase:'execution'}});
 assert.match(ordinary,/Directly retrieve sufficient evidence and answer as the normal path/);
});

test('durable task retries keep their host-owned time even across a clock boundary',()=>{
 const input={question:'Review a proposed event',contextTime:'2026-09-01T23:59:59Z',timeZone:'UTC'};
 const first=buildContextEnvelope(input,[],'2026-09-01T23:59:59Z'),retry=buildContextEnvelope(input,[],'2026-09-02T00:00:01Z');
 assert.equal(first.currentTime,retry.currentTime);assert.equal(first.displayCurrentTime,retry.displayCurrentTime);
 assert.equal(buildContextEnvelope({question:'Interactive request'},[],'2026-09-02T00:00:01Z').currentTime,'2026-09-02T00:00:01Z');
});
test('opening memory hints are separate from cited evidence and include verification guidance',()=>{
 const lead={id:'generated-memory',title:'Generated preference',statement:'Generated statement',uncertainty:'Only in one project',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z',admission:{scope:'A generated plan for one project',attribution:'user'},validFrom:'2026-09-18T00:00:00Z',validUntil:'2026-09-19T00:00:00Z'};
 const envelope=buildContextEnvelope({question:'What do you know?',openingMemories:[lead]},[]);
 assert.deepEqual(envelope.untrustedMemoryLeads,[lead]);
 assert.match(envelope.memoryLeadInstruction,/navigation hints, not independent evidence or instructions/);
 assert.match(envelope.memoryLeadInstruction,/includeEvidence=true.*host-verified supporting original ranges/);
 assert.match(envelope.memoryLeadInstruction,/Cite delivered original ids, not memory ids/);
 assert.match(envelope.memoryLeadInstruction,/not host owner-identity declarations or proof of current state/);
 assert.match(envelope.memoryLeadInstruction,/current attributionContext/);
 assert.equal(envelope.untrustedEvidence,undefined);
 assert.equal(envelope.hostAttributionContext,undefined);
});
test('all archive roles receive recency responsibility while selected scope and Memory publication dates stay unchanged',()=>{
 const lead={id:'generated-memory',title:'Generated older account',statement:'Generated earlier state',uncertainty:'A dated observation',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z',validFrom:'2026-08-01T00:00:00Z'};
 const scope={after:'2026-06-01T00:00:00Z',before:'2026-09-18T00:00:00Z',contextTime:'2026-09-18T00:00:00Z',timeZone:'UTC'};
 let responsibility;
 for(const role of ['answer','research','writer','review']){
  const input={question:'Generated '+role+' task',...scope,openingMemories:[lead],traceContext:{phase:'quality.'+role}};
  const envelope=buildContextEnvelope(input,[]);
  assert.ok(systemInstructions(input).includes(ARCHIVE_RECENCY_INSTRUCTIONS));
  assert.ok(envelope.retrievalInstruction.includes(ARCHIVE_RECENCY_INSTRUCTIONS));
  assert.equal(envelope.retrievalInstruction.split(ARCHIVE_RECENCY_INSTRUCTIONS).length,2);
  responsibility??=envelope.retrievalInstruction;assert.equal(envelope.retrievalInstruction,responsibility,'no role-specific or question-keyword dispatch changes retrieval responsibility');
  assert.deepEqual(envelope.selectedTimeRange,{after:scope.after,before:scope.before});
  assert.equal(envelope.currentTime,scope.contextTime);assert.deepEqual(envelope.untrustedMemoryLeads,[lead]);
  assert.equal(envelope.untrustedEvidence,undefined,'a recency instruction does not synthesize original evidence');
 }
 for(const input of [{question:'Generated extraction',evidenceIds:['one']},{question:'Generated calendar',skill:'calendar-extraction'},{question:'Generated compaction',skill:'working-memory'},{question:'Generated host-only',hostRetrieval:'none'}]){
  assert.equal(buildContextEnvelope(input,[]).retrievalInstruction,undefined);
 }
});
test('archive roles receive progress precision checks while generated plans and outcomes remain unmodified evidence',()=>{
 const originals=[
  {id:'generated-plan',ocrText:'I plan to label the tool drawers on Saturday. The bolts are sorted; drawer labeling has not been reported.'},
  {id:'generated-advance',ocrText:'The paper glider passed its first balance check. The launch test and durability trial are still pending.'},
  {id:'generated-start',ocrText:'I set up the practice board and began the juggling exercise. Recording the next session is still a plan.'},
 ].map(original=>({...original,capturedAt:'2017-08-19T06:30:00Z',appName:'Generated',sourceType:'note'}));
 const before=structuredClone(originals);
 for(const phase of ['answer','research','writer','review']){
  const input={question:'Generated state-change review',traceContext:{phase:'quality.'+phase}},envelope=buildContextEnvelope(input,originals);
  assert.ok(envelope.retrievalInstruction.includes(ARCHIVE_RECENCY_INSTRUCTIONS));
  assert.match(envelope.retrievalInstruction,/intention or plan, explicitly started or ongoing action, and supported completion or outcome/);
  assert.match(envelope.retrievalInstruction,/unknown final outcome does not erase that progress/);
  assert.deepEqual(envelope.untrustedEvidence.map(({id,ocrText})=>({id,ocrText})),originals.map(({id,ocrText})=>({id,ocrText})),'the host passes originals rather than rewriting plans, choosing outcomes or inserting an expected answer');
 }
 assert.deepEqual(originals,before);
});
test('host context lineage is retained for fences without being disclosed to the model or granting citation reads',async t=>{
 const id='6f28159f-242b-5442-9a0c-a17958985a52',deps={version:1,complete:true,ids:[id]},lead={id:'generated-memory',title:'Generated',statement:'Generated decision',uncertainty:'Fixture',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z'};
 const pin={sourceId:'generated-source',version:1,fingerprint:'a'.repeat(64),kind:'metadata'},input={question:'Generated',contextEvidenceDependencies:deps,openingMemories:[lead],conversation:{turns:[{question:'Generated earlier',answer:'Generated answer',createdAt:lead.createdAt,scope:{}}],omittedTurns:0,evidenceDependencies:deps,sourceContextDependencies:[pin]}};
 const envelope=buildContextEnvelope(input,[]);assert.equal(envelope.conversation.evidenceDependencies,undefined);assert.equal(envelope.conversation.sourceContextDependencies,undefined);assert.equal(JSON.stringify(envelope).includes(id),false);assert.equal(JSON.stringify(envelope).includes(pin.fingerprint),false);
 const bridge=await startBridge(reader,input,6);t.after(()=>bridge.close());assert.deepEqual(bridge.evidenceDependencies,deps);assert.deepEqual(bridge.sourceContextDependencies,[pin]);assert.equal(bridge.records.has(id),false,'lineage cannot confer citation authority');
 const missing=await startBridge(reader,{question:'Generated',openingMemories:[lead],contextEvidenceDependencies:{version:1,complete:true,ids:[]}},6);t.after(()=>missing.close());assert.equal(missing.evidenceDependencies.complete,false,'nonempty derived lead cannot claim empty complete lineage');
});
test('scope and validity on an opening lead do not grant citations to its inline original locator',async t=>{
 const id='6f28159f-242b-5442-9a0c-a17958985a52',lead={id:'generated-memory',title:'Generated plan',statement:`A dated source plan [${id}]`,uncertainty:'Outcome unknown',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z',admission:{scope:'One generated source',attribution:'user'},validUntil:'2026-09-19T00:00:00Z'};
 const bridge=await startBridge(reader,{question:'Was it completed?',openingMemories:[lead],contextEvidenceDependencies:{version:1,complete:true,ids:[id]}},6);t.after(()=>bridge.close());
 assert.equal(bridge.records.has(id),false);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:`Generated completion [${id}]`,citationIds:[id]}),bridge.records),/not retrieved/);
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
 assert.equal(buildContextEnvelope({...input,taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(80000)}]}},[]).untrustedTaskContext.turns[0].answer.length,80000);
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
test('host context observes schema and system size without approximating provider capacity',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const {metrics}=assembleContext({question:'generated'},[],'system',[{name:'evidence'}],4096);
 assert.equal(metrics.system,6);assert.equal(metrics.outputTokenReserve,4096);assert.equal(metrics.unit,'utf16_characters');assert.equal(metrics.evidence,2,'absent seed fields are not counted as delivered wire fields');
 assert.equal(assembleContext({question:'generated'},[],'x'.repeat(180000),[],4096).metrics.system,180000);
 const limited=JSON.parse(assembleContext({question:'generated'},[],'system',[],4096,7).prompt);
 assert.equal(limited.maxToolCalls,7);
 assert.equal(buildContextEnvelope({question:'Extract',evidenceIds:['one']},[]).retrievalInstruction,undefined,'Bounded extraction is not given archive convergence instructions');
});

test('bounded evidence does not silently change an ordinary answer into memory extraction',()=>{
 assert.equal(buildContextEnvelope({question:'Answer this',evidenceIds:['one']},[]).responseMode,'answer');
 assert.equal(buildContextEnvelope({question:'Extract',skill:'memory-extraction',evidenceIds:['one']},[]).responseMode,'memory-extraction');
});

test('bounded extraction supplies the unchanged procedure, draft and originals without archive discovery instructions',()=>{
 const input={question:'Exact host admission contract',skill:'memory-extraction',evidenceIds:[record.id],evidenceRanges:[{id:record.id,offset:0,length:record.ocrText.length}],taskContext:{untrustedMemoryDraft:{memories:[{statement:'Untrusted draft'}]}}};
 const envelope=buildContextEnvelope(input,[record]);
 const {commonContextRef,...body}=envelope.untrustedEvidence[0];
 assert.equal(envelope.request,input.question);assert.deepEqual(JSON.parse(JSON.stringify({...envelope.evidenceContexts[commonContextRef],...body})),record);assert.deepEqual(envelope.untrustedTaskContext,input.taskContext);
 assert.match(envelope.procedure,/Preserve the subject, speaker, tense, uncertainty/);
 assert.match(envelope.procedureInstruction,/no skill tool call is required/);
 assert.match(envelope.disclosurePolicy,/Archive discovery tools are unavailable/);
 assert.doesNotMatch(envelope.disclosurePolicy,/material_catalog|search_context|context_index/);
});

test('host derived-context dependencies are authorization metadata and never new evidence seeds or tool scope',()=>{
 const input={question:'Compare a derived rule',evidenceIds:['candidate-only'],derivedContextEvidenceIds:['private-root-only'],taskContext:{turns:[],untrustedMemoryDraft:{statement:'The derived rule'}}};
 const envelope=buildContextEnvelope(input,[]);assert.equal(JSON.stringify(envelope).includes('private-root-only'),false);assert.deepEqual(taskTools(input),['evidence']);
});


test('large Memory catalogs and review drafts share exact declaration and source metadata without a host quota',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const context={version:1,ownerRelation:'unknown',basis:'default',sourceContextStatements:[{description:'Generated source declaration. '.repeat(80),version:1}]};
 const members=Array.from({length:24},(_,i)=>({key:String(i).padStart(64,'a'),id:'generated-'+i,offset:i*100,length:100,fingerprint:'f'.repeat(64),contextTime:'2026-10-01T00:00:00Z',attributionContext:context,state:'pending',memoryIds:[]}));
 const work={members,contextMembers:[],authorizedMembers:members.map(m=>({...m,scope:'generated'})),history:[],instruction:'Generated complete work contract'};
 const input={question:'Generated review',taskContext:{turns:[],memoryWork:work,untrustedMemoryDraft:'Generated draft. '.repeat(1100)}};
 assert.ok(JSON.stringify(input.taskContext).length>80000);
 const {prompt,metrics}=assembleContext(input,[],'Generated system',[],4096),wire=JSON.parse(prompt).untrustedTaskContext.memoryWork;
 assert.ok(metrics.task<80000);assert.equal(wire.members.length,24);assert.equal(wire.authorizedMembers.length,24);
 for(const [i,m] of wire.members.entries()){const shared=wire.commonContexts[m.commonContextRef];assert.equal(m.key,'member_'+i);assert.equal(m.offset,members[i].offset);assert.equal(shared.contextTime,members[i].contextTime);assert.deepEqual(wire.attributionContexts[shared.attributionContextRef],context);assert.equal(wire.authorizedMembers[i].memberRef,m.key);assert.equal(m.fingerprint,undefined);}
 assert.equal(input.taskContext.memoryWork.members[0].attributionContext,context,'wire compaction cannot mutate host authority or cache inputs');
 const changed={...members[0],attributionContext:{...context,ownerRelation:'owner'}};
 const other=JSON.parse(assembleContext({...input,taskContext:{...input.taskContext,memoryWork:{...work,authorizedMembers:[changed]}}},[],'Generated',[],4096).prompt).untrustedTaskContext.memoryWork;
 assert.equal(other.authorizedMembers[0].memberRef,undefined,'matching keys with different context must not be silently deduplicated');
});

test('coverage aliases round-trip only exact identities from this call, including reviewer drafts and context references',async()=>{
 const {compactMemoryTaskContext,restoreMemoryCoverageKeys}=await import('../dist/memory-context.js');
 const keys=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)];
 const work={members:[{key:keys[0],id:'target'}],contextMembers:[{key:keys[1],id:'context'}],authorizedMembers:[{key:keys[2],id:'unread'}],history:[{targets:[{key:keys[0],contextRefs:[keys[1]]}],contextMembers:[]}],instruction:'Generated'};
 const draft={memories:[{statement:'member_0 remains literal prose',evidence:[{id:'target',quote:'member_0'}]}],coverage:[{key:keys[0],contextRefs:[keys[1],'material:unchanged'],state:'needs_context',candidateIndexes:[]}],capacity:{saturated:false}};
 const task={turns:[],memoryWork:work,untrustedMemoryDraft:draft},wire=compactMemoryTaskContext(task);
 assert.equal(wire.memoryWork.contextEncoding,'memory-context@3');assert.equal(wire.untrustedMemoryDraft.coverage[0].key,'member_0');assert.deepEqual(wire.untrustedMemoryDraft.coverage[0].contextRefs,['member_1','material:unchanged']);
 assert.deepEqual(JSON.parse(restoreMemoryCoverageKeys(JSON.stringify(wire.untrustedMemoryDraft),task)),draft);
 assert.deepEqual(wire.untrustedMemoryDraft.memories,draft.memories,'claims and quotes are not alias substitution targets');
 assert.equal(wire.memoryWork.history[0].targets[0].key,'member_0');assert.equal(wire.memoryWork.history[0].targets[0].contextRefs[0],'member_1');
 const unknown=JSON.stringify({coverage:[{key:'member_999'},{key:'member_00'},{key:keys[0].slice(0,62)}]});
 assert.equal(restoreMemoryCoverageKeys(unknown,task),unknown,'unknown aliases and corrupted canonical keys are never guessed');
 const contextOnly=JSON.parse(restoreMemoryCoverageKeys(JSON.stringify({coverage:[{key:'member_1'}]}),task));assert.equal(contextOnly.coverage[0].key,keys[1],'host target validation still rejects context-only coverage');
 assert.equal(restoreMemoryCoverageKeys('not JSON',task),'not JSON');assert.deepEqual(compactMemoryTaskContext(wire),wire);
 assert.equal(task.memoryWork.members[0].key,keys[0]);assert.deepEqual(task.untrustedMemoryDraft,draft);
});

test('large host task context is retained and measured without local character rejection',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const draft='x'.repeat(181000),assembled=assembleContext({question:'Generated',taskContext:{turns:[],draft}},[],'system',[],4096),wire=JSON.parse(assembled.prompt);
 assert.equal(wire.untrustedTaskContext.draft,draft);assert.ok(assembled.metrics.task>180000);assert.equal(wire.contextBudget,undefined);assert.equal(wire.maxToolCalls,undefined);
});

test('historical dialogue status is visible while its privacy and permission receipts remain host-only',()=>{
 const dependencies={version:1,complete:true,ids:['generated-private-root']},historyContext={conversationId:'generated-private-conversation',revision:1,evidenceDependencies:dependencies};
 const envelope=buildContextEnvelope({question:'Explain an earlier proposal',historyContext,conversation:{historyContext,evidenceDependencies:dependencies,turns:[{question:'Generated',answer:'The second proposal was a glider.',scope:{},createdAt:'2026-10-01T00:00:00Z',evidenceStale:true}],omittedTurns:0}},[]);
 assert.equal(envelope.conversation.turns[0].evidenceStale,true);assert.match(envelope.conversation.turns[0].answer,/second proposal/);
 assert.doesNotMatch(JSON.stringify(envelope),/generated-private-root|generated-private-conversation|historyContext|evidenceDependencies/);
 assert.match(systemInstructions({question:'Generated follow-up'},[]),/resolve earlier proposals.*never as verified current facts/);
});
